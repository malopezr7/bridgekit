// ---------------------------------------------------------------------------
// StateMirror — per (contract, key, scope) local mirror of provider state.
// Seeded from descriptor initial; kept fresh by a single transport.stateObserve.
//
// LocalStateMirror — mirrors state from the JS registry (local-first path).
// Subscribes to Registry.subscribeState instead of transport.stateObserve.
// Transport methods are no-ops (local state never crosses to native).
// ---------------------------------------------------------------------------

import { decode, validate } from '../contract/codec';
import type { BridgeContract } from '../contract/contract';
import { type BridgeError, type BridgeScope, createBridgeError } from '../contract/protocol';
import type { AnySchema } from '../contract/schema';
import { nextCorrelationId } from './correlationId';
import { diagnostics } from './diagnostics';
import type { Registry } from './registry';
import { serializeScope } from './registry';
import type { BridgeTransport } from './transport';

/**
 * Status of a state mirror value.
 *
 * - `initial`:     No observation has started yet (mirror just created, no subscriber).
 * - `provided`:    A provider is active and a value has been mirrored for the current epoch.
 * - `stale`:       A value was last received from a provider that has since disconnected
 *                  (reconnect in-flight within the grace window). Value is still accessible.
 * - `unprovided`:  No provider is registered and no stale value exists.
 */
export type MirrorStatus = 'initial' | 'provided' | 'stale' | 'unprovided';

export interface MirrorValue<T> {
  value: T;
  status: MirrorStatus;
  error?: BridgeError;
}

type ChangeCallback<T> = (v: MirrorValue<T>) => void;

// ---- StateMirror -----------------------------------------------------------

export class StateMirror<T> {
  private _value: T;
  private _status: MirrorStatus = 'initial';
  private _subscribers = new Set<ChangeCallback<T>>();
  private _obsId: string | null = null;
  private _transport: BridgeTransport | null = null;
  private _error: BridgeError | undefined;
  // True while _value holds a raw wire value applied without a schema
  // (snapshot hydration through a descriptor-less stub). See setSchema (JD2-002).
  private _schemalessValue = false;
  // Cached snapshot — same object reference until value or status changes.
  // Required by React's useSyncExternalStore which compares by Object.is.
  private _snapshot: MirrorValue<T>;

  constructor(
    private readonly _contractId: string,
    private readonly _key: string,
    private readonly _scope: BridgeScope,
    initial: T,
    private _schema?: AnySchema,
  ) {
    this._value = initial;
    this._snapshot = { value: this._value, status: this._status };
  }

  get(): MirrorValue<T> {
    return this._snapshot;
  }

  /** Invalidate cached snapshot after any internal state change. */
  private _updateSnapshot(): void {
    this._snapshot = {
      value: this._value,
      status: this._status,
      ...(this._error ? { error: this._error } : {}),
    };
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
  hydrate(value: unknown): void {
    this._applyRaw(value);
  }

  setSchema(schema: AnySchema | undefined, fallbackInitial?: unknown): void {
    if (this._schema || !schema) return;
    this._schema = schema;
    if (this._status === 'provided') {
      const raw = this._value;
      if (this._schemalessValue) {
        // JD2-002: the current value is an undecoded wire value applied before
        // the schema attached. If the re-decode below fails, the raw wire repr
        // must not survive as last-good — fall back to the typed initial.
        this._value = fallbackInitial as T;
        this._schemalessValue = false;
      }
      this._applyRaw(raw);
    }
  }

  /** Called when transport becomes available */
  attachTransport(transport: BridgeTransport): void {
    this._transport = transport;
    if (this._subscribers.size > 0 && this._obsId === null) {
      this._attachObserver();
    }
  }

  /** Called on epoch change — detach and mark stale (value kept accessible). */
  detachTransport(opts?: { notify?: boolean }): boolean {
    const beforeValue = this._value;
    const beforeStatus = this._status;
    if (this._obsId !== null && this._transport) {
      try {
        this._transport.stateUnobserve(this._obsId);
      } catch {
        // ignore
      }
      this._obsId = null;
    }
    this._transport = null;
    // Keep the last known value but mark stale so consumers can distinguish from
    // `unprovided`. The grace window (W2-3) resolves stale→unprovided via native timer.
    if (this._status === 'provided') {
      this._status = 'stale';
    } else {
      this._status = 'unprovided';
    }
    const changed = !Object.is(beforeValue, this._value) || beforeStatus !== this._status;
    if (changed) {
      this._updateSnapshot();
    }
    if (changed && opts?.notify !== false) {
      this._notify();
    }
    return changed;
  }

  notifyIfNotProvided(): void {
    if (this._status !== 'provided') {
      this._notify();
    }
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
      this._applyRaw(raw);
    });
  }

  private _applyRaw(raw: unknown): void {
    if (raw === undefined) {
      // Provider gone — if we had a value keep it as stale, else unprovided.
      this._status = this._status === 'provided' ? 'stale' : 'unprovided';
      this._updateSnapshot();
      this._notify();
      return;
    }

    try {
      const decoded = this._schema ? decode(this._schema, raw) : raw;
      if (this._schema) {
        const result = validate(this._schema, decoded);
        if (!result.ok) {
          throw new Error(`${result.message} at path "${result.path}"`);
        }
      }
      this._value = decoded as T;
      this._schemalessValue = !this._schema;
      this._status = 'provided';
      this._error = undefined;
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      this._error = createBridgeError(
        'INCOMPATIBLE_CONTRACT',
        `[bridgekit] INCOMPATIBLE_CONTRACT: ${this._contractId}.${this._key} state decode failed: ${cause}`,
        {
          contractId: this._contractId,
          member: this._key,
          scope: this._scope,
          details: { cause },
        },
      );
      diagnostics.incrementErrors();
    }
    this._updateSnapshot();
    this._notify();
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb(this._snapshot);
      } catch {
        // State listeners are observers; one failed observer must not abort hydration.
      }
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
  private _status: MirrorStatus = 'provided';
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
            // Local state has no epoch/reconnect concept — gone means unprovided.
            this._status = 'unprovided';
          } else {
            this._value = raw as T;
            this._status = 'provided';
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
  detachTransport(): boolean {
    return false;
  }

  /** Not called for local mirrors (snapshot hydration is native-only). */
  hydrate(_value: T): void {}

  private _notify(): void {
    for (const cb of this._subscribers) {
      cb(this._snapshot);
    }
  }
}

// ---- NativeReadinessMirror ---------------------------------------------------

export interface NativeReadinessEntry {
  contractId: string;
  scope: BridgeScope;
}

export interface NativeReadinessDelta extends NativeReadinessEntry {
  op: 'provide' | 'unprovide';
  seq: number;
}

type NativeReadinessRecord = {
  contractId: string;
  provided: boolean;
  scopeKey: string;
  seq: number;
};

type NativeReadinessSubscriber = (record: NativeReadinessRecord) => void;

function candidateScopes(scope: BridgeScope): BridgeScope[] {
  if (scope.kind === 'instance') {
    return [scope, { kind: 'feature', feature: scope.feature }, { kind: 'global' }];
  }
  if (scope.kind === 'feature') {
    return [scope, { kind: 'global' }];
  }
  return [{ kind: 'global' }];
}

/** Consumer-side mirror for native provider readiness, hydrated from connect and deltas. */
export class NativeReadinessMirror {
  private readonly _records = new Map<string, NativeReadinessRecord>();
  private readonly _subscribers = new Set<NativeReadinessSubscriber>();

  hydrate(entries: NativeReadinessEntry[]): void {
    const previous = new Map(this._records);
    const nextKeys = new Set<string>();
    this._records.clear();
    for (const entry of entries) {
      const scopeKey = serializeScope(entry.scope);
      const key = this._key(entry.contractId, scopeKey);
      nextKeys.add(key);
      this._records.set(key, {
        contractId: entry.contractId,
        provided: true,
        scopeKey,
        seq: 0,
      });
    }
    this._notifyAll();
    for (const [key, record] of previous) {
      if (nextKeys.has(key)) continue;
      if (!record.provided) continue;
      this._notify({ ...record, provided: false, seq: 0 });
    }
  }

  applyDelta(delta: NativeReadinessDelta): void {
    const scopeKey = serializeScope(delta.scope);
    const key = this._key(delta.contractId, scopeKey);
    const current = this._records.get(key);
    if (current !== undefined && delta.seq <= current.seq) return;

    const next = {
      contractId: delta.contractId,
      provided: delta.op === 'provide',
      scopeKey,
      seq: delta.seq,
    };
    this._records.set(key, next);
    this._notify(next);
  }

  isProvided(contractId: string, scope: BridgeScope): boolean {
    return candidateScopes(scope).some((candidate) => {
      const record = this._records.get(this._key(contractId, serializeScope(candidate)));
      return record?.provided === true;
    });
  }

  subscribe(cb: NativeReadinessSubscriber): () => void {
    this._subscribers.add(cb);
    return () => {
      this._subscribers.delete(cb);
    };
  }

  dump(): NativeReadinessRecord[] {
    return Array.from(this._records.values()).sort((a, b) => {
      const contractOrder = a.contractId.localeCompare(b.contractId);
      return contractOrder !== 0 ? contractOrder : a.scopeKey.localeCompare(b.scopeKey);
    });
  }

  private _key(contractId: string, scopeKey: string): string {
    return `${contractId}|${scopeKey}`;
  }

  private _notify(record: NativeReadinessRecord): void {
    for (const cb of this._subscribers) {
      try {
        cb(record);
      } catch {
        // Readiness listeners are observers; one failed observer must not abort hydration.
      }
    }
  }

  private _notifyAll(): void {
    for (const record of this._records.values()) this._notify(record);
  }
}

// ---- MirrorRegistry --------------------------------------------------------

/** Manages all mirrors for a BridgeKitJs instance. */
export class MirrorRegistry {
  private readonly _mirrors = new Map<string, StateMirror<unknown>>();

  private _key(contractId: string, key: string, scopeKey: string): string {
    return `${contractId}|${key}|${scopeKey}`;
  }

  keyFor(contractId: string, key: string, scope: BridgeScope): string {
    return this._key(contractId, key, serializeScope(scope));
  }

  getOrCreate<T>(
    contract: BridgeContract<unknown>,
    key: string,
    scope: BridgeScope,
    initial: T,
  ): StateMirror<T> {
    const k = this.keyFor(contract.descriptor.id, key, scope);
    const stateDesc = contract.descriptor.state[key];
    const schema = stateDesc && 'value' in stateDesc ? stateDesc.value : undefined;
    if (!this._mirrors.has(k)) {
      this._mirrors.set(
        k,
        new StateMirror(
          contract.descriptor.id,
          key,
          scope,
          initial,
          schema,
        ) as unknown as StateMirror<unknown>,
      );
    }
    const mirror = this._mirrors.get(k);
    if (mirror === undefined) throw new Error('[bridgekit] internal: mirror not found after set');
    // JD2-002: pass the typed descriptor initial so a failed re-decode of a
    // schema-less hydrated wire value falls back to it instead of leaking raw.
    mirror.setSchema(schema, initial);
    return mirror as unknown as StateMirror<T>;
  }

  attachAll(transport: BridgeTransport): void {
    for (const mirror of this._mirrors.values()) {
      mirror.attachTransport(transport);
    }
  }

  detachAll(opts?: { notify?: boolean }): Set<string> {
    const changed = new Set<string>();
    for (const [key, mirror] of this._mirrors.entries()) {
      if (mirror.detachTransport(opts)) {
        changed.add(key);
      }
    }
    return changed;
  }

  notifyNotProvided(keys: Iterable<string>): void {
    for (const key of keys) {
      this._mirrors.get(key)?.notifyIfNotProvided();
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
