// ---------------------------------------------------------------------------
// StateMirror — per (contract, key, scope) local mirror of provider state.
// Seeded from descriptor initial; kept fresh by a single transport.stateObserve.
//
// LocalStateMirror — mirrors state from the JS registry (local-first path).
// Subscribes to Registry.subscribeState instead of transport.stateObserve.
// Transport methods are no-ops (local state never crosses to native).
// ---------------------------------------------------------------------------

import type { BridgeContract } from '../contract/contract';
import type { BridgeScope } from '../contract/protocol';
import { nextCorrelationId } from './correlationId';
import type { Registry } from './registry';
import { serializeScope } from './registry';
import type { BridgeTransport } from './transport';

export type MirrorStatus = 'initial' | 'available' | 'unprovided';

export interface MirrorValue<T> {
  value: T;
  status: MirrorStatus;
}

type ChangeCallback<T> = (v: MirrorValue<T>) => void;

// ---- StateMirror -----------------------------------------------------------

export class StateMirror<T> {
  private _value: T;
  private _status: MirrorStatus = 'initial';
  private _subscribers = new Set<ChangeCallback<T>>();
  private _obsId: string | null = null;
  private _transport: BridgeTransport | null = null;
  // Cached snapshot — same object reference until value or status changes.
  // Required by React's useSyncExternalStore which compares by Object.is.
  private _snapshot: MirrorValue<T>;

  constructor(
    private readonly _contractId: string,
    private readonly _key: string,
    private readonly _scope: BridgeScope,
    initial: T,
  ) {
    this._value = initial;
    this._snapshot = { value: this._value, status: this._status };
  }

  get(): MirrorValue<T> {
    return this._snapshot;
  }

  /** Invalidate cached snapshot after any internal state change. */
  private _updateSnapshot(): void {
    this._snapshot = { value: this._value, status: this._status };
  }

  subscribe(cb: ChangeCallback<T>): () => void {
    this._subscribers.add(cb);
    // Attach transport observer if first subscriber
    if (this._subscribers.size === 1 && this._transport && this._obsId === null) {
      this._attachObserver();
    }
    return () => {
      this._subscribers.delete(cb);
      if (this._subscribers.size === 0 && this._obsId !== null && this._transport) {
        this._transport.stateUnobserve(this._obsId);
        this._obsId = null;
      }
    };
  }

  /** Hydrate from connect snapshot */
  hydrate(value: T): void {
    this._value = value;
    this._status = 'available';
    this._updateSnapshot();
    this._notify();
  }

  /** Called when transport becomes available */
  attachTransport(transport: BridgeTransport): void {
    this._transport = transport;
    if (this._subscribers.size > 0 && this._obsId === null) {
      this._attachObserver();
    }
  }

  /** Called on epoch change — detach and clear obsId */
  detachTransport(): void {
    if (this._obsId !== null && this._transport) {
      try {
        this._transport.stateUnobserve(this._obsId);
      } catch {
        // ignore
      }
      this._obsId = null;
    }
    this._transport = null;
    this._status = 'unprovided';
    this._updateSnapshot();
    this._notify();
  }

  private _attachObserver(): void {
    if (!this._transport) return;
    const env = {
      op: 'stateObserve' as const,
      contractId: this._contractId,
      member: this._key,
      scope: this._scope,
      correlationId: nextCorrelationId(),
      epoch: 0, // transport fills epoch
    };
    this._obsId = this._transport.stateObserve(env, (raw) => {
      if (raw === undefined) {
        // Provider gone
        this._status = 'unprovided';
      } else {
        this._value = raw as T;
        this._status = 'available';
      }
      this._updateSnapshot();
      this._notify();
    });
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      cb(this._snapshot);
    }
  }
}

// ---- LocalStateMirror -------------------------------------------------------

/**
 * State mirror backed by the JS Registry (local-first path).
 * Used when a contract is locally provided — reads from Registry.getState /
 * Registry.subscribeState instead of transport.stateObserve.
 *
 * Transport attach/detach methods are no-ops: local state never crosses to native.
 */
export class LocalStateMirror<T> {
  private _value: T;
  private _status: MirrorStatus = 'available';
  private _subscribers = new Set<ChangeCallback<T>>();
  private _snapshot: MirrorValue<T>;
  private _unsub: (() => void) | null = null;

  constructor(
    private readonly _registry: Registry,
    private readonly _contractId: string,
    private readonly _key: string,
    private readonly _scope: BridgeScope,
    initial: T,
  ) {
    // Seed from live registry state (may differ from descriptor initial if already set)
    const live = _registry.getState(_contractId, _scope, _key);
    this._value = live !== undefined ? (live as T) : initial;
    this._snapshot = { value: this._value, status: this._status };
  }

  get(): MirrorValue<T> {
    return this._snapshot;
  }

  private _updateSnapshot(): void {
    this._snapshot = { value: this._value, status: this._status };
  }

  subscribe(cb: ChangeCallback<T>): () => void {
    this._subscribers.add(cb);
    if (this._subscribers.size === 1 && this._unsub === null) {
      this._unsub = this._registry.subscribeState(
        this._contractId,
        this._scope,
        this._key,
        (raw) => {
          if (raw === undefined) {
            this._status = 'unprovided';
          } else {
            this._value = raw as T;
            this._status = 'available';
          }
          this._updateSnapshot();
          this._notify();
        },
      );
    }
    return () => {
      this._subscribers.delete(cb);
      if (this._subscribers.size === 0 && this._unsub !== null) {
        this._unsub();
        this._unsub = null;
      }
    };
  }

  /** No-op: local mirrors don't use transport. */
  attachTransport(_transport: BridgeTransport): void {}

  /** No-op: local mirrors don't use transport. */
  detachTransport(): void {}

  /** Not called for local mirrors (snapshot hydration is native-only). */
  hydrate(_value: T): void {}

  private _notify(): void {
    for (const cb of this._subscribers) {
      cb(this._snapshot);
    }
  }
}

// ---- MirrorRegistry --------------------------------------------------------

/** Manages all mirrors for a BridgeKitJs instance. */
export class MirrorRegistry {
  private readonly _mirrors = new Map<string, StateMirror<unknown>>();

  private _key(contractId: string, key: string, scopeKey: string): string {
    return `${contractId}|${key}|${scopeKey}`;
  }

  getOrCreate<T>(
    contract: BridgeContract<unknown>,
    key: string,
    scope: BridgeScope,
    initial: T,
  ): StateMirror<T> {
    const scopeKey = serializeScope(scope);
    const k = this._key(contract.descriptor.id, key, scopeKey);
    if (!this._mirrors.has(k)) {
      this._mirrors.set(
        k,
        new StateMirror(
          contract.descriptor.id,
          key,
          scope,
          initial,
        ) as unknown as StateMirror<unknown>,
      );
    }
    const mirror = this._mirrors.get(k);
    if (mirror === undefined) throw new Error('[bridgekit] internal: mirror not found after set');
    return mirror as unknown as StateMirror<T>;
  }

  attachAll(transport: BridgeTransport): void {
    for (const mirror of this._mirrors.values()) {
      mirror.attachTransport(transport);
    }
  }

  detachAll(): void {
    for (const mirror of this._mirrors.values()) {
      mirror.detachTransport();
    }
  }

  dump(): Array<{
    contractId: string;
    key: string;
    scopeKey: string;
    status: MirrorStatus;
    value: unknown;
  }> {
    return Array.from(this._mirrors.entries()).map(([k, mirror]) => {
      const parts = k.split('|');
      const mv = mirror.get();
      return {
        contractId: parts[0] ?? '',
        key: parts[1] ?? '',
        scopeKey: parts[2] ?? '',
        status: mv.status,
        value: mv.value,
      };
    });
  }
}
