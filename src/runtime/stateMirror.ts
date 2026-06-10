// ---------------------------------------------------------------------------
// StateMirror — per (contract, key, scope) local mirror of provider state.
// Seeded from descriptor initial; kept fresh by a single transport.stateObserve.
// ---------------------------------------------------------------------------

import type { BridgeContract } from '../contract/contract';
import type { BridgeScope } from '../contract/protocol';
import { nextCorrelationId } from './correlationId';
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

  constructor(
    private readonly _contractId: string,
    private readonly _key: string,
    private readonly _scope: BridgeScope,
    initial: T,
  ) {
    this._value = initial;
  }

  get(): MirrorValue<T> {
    return { value: this._value, status: this._status };
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
      this._notify();
    });
  }

  private _notify(): void {
    const snapshot = this.get();
    for (const cb of this._subscribers) {
      cb(snapshot);
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
