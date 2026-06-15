// ---------------------------------------------------------------------------
// Registry — bindings keyed by (contractId, scopeKey).
// Resolution walks instance → feature → global.
// ---------------------------------------------------------------------------

import type { BridgeContract } from '../contract/contract';
import type { BridgeScope } from '../contract/protocol';
import { diagnostics } from './diagnostics';

// ---- __DEV__ guard ----------------------------------------------------------

function isDev(): boolean {
  try {
    if (typeof __DEV__ === 'boolean') return __DEV__;
  } catch {
    // ignore ReferenceError
  }
  return process.env.NODE_ENV !== 'production';
}

// ---- scope serialization ---------------------------------------------------

export function serializeScope(scope: BridgeScope): string {
  switch (scope.kind) {
    case 'global':
      return 'global';
    case 'feature':
      return `feature:${scope.feature ?? ''}`;
    case 'instance':
      return `instance:${scope.feature ?? ''}:${scope.instance ?? ''}`;
  }
}

export const GLOBAL_SCOPE: BridgeScope = { kind: 'global' };

// ---- Binding handle -------------------------------------------------------

export interface Binding {
  readonly contractId: string;
  readonly scope: BridgeScope;
  readonly scopeKey: string;
  readonly impl: unknown;
  isLive: boolean;
  /** Set provider-owned state. Notifies state mirrors. */
  setState(key: string, value: unknown): void;
  /** close('replacing') holds incoming calls for grace window; close('final') fails them. */
  close(reason?: 'replacing' | 'final'): void;
}

// ---- RegistryEntry --------------------------------------------------------

interface RegistryEntry {
  binding: Binding;
  /** Waiting callers — resolve when binding becomes live after 'replacing' */
  pendingCallers: Array<{ resolve: () => void; reject: (reason: unknown) => void }>;
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Per-key state values */
  state: Map<string, unknown>;
}

// ---- Readiness waiters -----------------------------------------------------

interface ReadinessWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---- Registry constants ---------------------------------------------------

const DEFAULT_READINESS_TIMEOUT_MS = 5000;
const DEFAULT_GRACE_WINDOW_MS = 1500;

// ---- Registry -------------------------------------------------------------

export class Registry {
  private readonly _entries = new Map<string, RegistryEntry>();
  private readonly _readinessWaiters = new Map<string, ReadinessWaiter[]>();
  // H-10: registry-level state listeners keyed contractId|scopeKey|stateKey.
  // Surviving across provider swaps — never cleared by an entry close.
  private readonly _stateListeners = new Map<string, Set<(value: unknown) => void>>();

  /** Composite key for a (contractId, scopeKey) pair */
  private _key(contractId: string, scopeKey: string): string {
    return `${contractId}|${scopeKey}`;
  }

  /** H-10: composite key for a registry-level state listener */
  private _stateKey(contractId: string, scopeKey: string, key: string): string {
    return `${contractId}|${scopeKey}|${key}`;
  }

  /**
   * Register an implementation. Returns a Binding handle.
   * Duplicate provide on occupied scope: supersedes with dev warning.
   */
  provide<TShape>(
    contract: BridgeContract<TShape>,
    impl: unknown,
    opts?: { scope?: BridgeScope },
  ): Binding {
    const scope = opts?.scope ?? GLOBAL_SCOPE;
    const scopeKey = serializeScope(scope);
    const contractId = contract.descriptor.id;
    const entryKey = this._key(contractId, scopeKey);

    const existing = this._entries.get(entryKey);
    if (existing?.binding.isLive) {
      if (isDev()) {
        console.warn(
          `[bridgekit] provide(${contractId}, ${scopeKey}): superseding existing binding.`,
        );
      }
      // Close the old one silently (replacing — its handle becomes no-op)
      existing.binding.isLive = false;
      existing.graceTimer !== null && clearTimeout(existing.graceTimer);
      // Resolve pending callers so they retry against new binding
      const pending = existing.pendingCallers.splice(0);
      for (const w of pending) {
        w.resolve();
      }
    }

    const entry: RegistryEntry = {
      binding: null as unknown as Binding, // filled below
      pendingCallers: [],
      graceTimer: null,
      state: new Map(),
    };

    // Seed initial state values from descriptor
    for (const [key, stateDesc] of Object.entries(contract.descriptor.state)) {
      entry.state.set(key, stateDesc.initial);
    }

    const binding: Binding = {
      contractId,
      scope,
      scopeKey,
      impl,
      isLive: true,
      setState: (key: string, value: unknown) => {
        if (!binding.isLive) return;
        entry.state.set(key, value);
        // H-10: notify registry-level listeners (survive provider swap)
        const sk = this._stateKey(contractId, scopeKey, key);
        const listeners = this._stateListeners.get(sk);
        if (listeners) {
          for (const cb of listeners) {
            cb(value);
          }
        }
      },
      close: (reason?: 'replacing' | 'final') => {
        if (!binding.isLive) return; // no-op if already superseded
        binding.isLive = false;
        this._entries.delete(entryKey);

        if (reason === 'replacing') {
          // Grace window: pendingCallers is never populated before this fires
          // (no callers can arrive during the synchronous close() call), so
          // the loop below is intentionally a no-op — kept for safety.
          const graceEntry = entry;
          const graceTimer = setTimeout(() => {
            // pendingCallers is always empty here (dead code path — kept for safety).
            const pending = graceEntry.pendingCallers.splice(0);
            for (const w of pending) {
              w.reject(new Error('CONTRACT_NOT_PROVIDED'));
            }
          }, DEFAULT_GRACE_WINDOW_MS);
          // 5.8: unref so the timer does not prevent Node.js process exit / test runner from terminating.
          (graceTimer as unknown as { unref?: () => void }).unref?.();
          entry.graceTimer = graceTimer;
        } else {
          // final: fail immediately
          const pending = entry.pendingCallers.splice(0);
          for (const w of pending) {
            w.reject(new Error('CONTRACT_NOT_PROVIDED'));
          }
          // H-10: notify registry-level state listeners of unprovided
          for (const [sk, listeners] of this._stateListeners) {
            if (sk.startsWith(`${contractId}|${scopeKey}|`)) {
              for (const cb of listeners) {
                cb(undefined); // undefined signals unprovided
              }
            }
          }
        }

        diagnostics.trace({
          op: 'binding.close',
          contractId,
          member: '',
          scopeKey,
          durationMs: 0,
          side: 'js',
        });
      },
    };

    entry.binding = binding;
    this._entries.set(entryKey, entry);

    // Resolve any readiness waiters
    this._notifyReadiness(contractId, scopeKey);

    diagnostics.trace({
      op: 'provide',
      contractId,
      member: '',
      scopeKey,
      durationMs: 0,
      side: 'js',
    });

    return binding;
  }

  /**
   * Resolve a binding for (contractId, scope).
   * Walks instance → feature → global.
   */
  resolve(contractId: string, scope: BridgeScope): RegistryEntry | undefined {
    // Walk resolution order: instance → feature → global
    const candidates: string[] = [];
    if (scope.kind === 'instance') {
      candidates.push(serializeScope(scope));
      candidates.push(serializeScope({ kind: 'feature', feature: scope.feature }));
      candidates.push('global');
    } else if (scope.kind === 'feature') {
      candidates.push(serializeScope(scope));
      candidates.push('global');
    } else {
      candidates.push('global');
    }

    for (const sk of candidates) {
      const entry = this._entries.get(this._key(contractId, sk));
      if (entry?.binding.isLive) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Wait until a binding is provided, bounded by timeoutMs.
   * Resolves immediately if already provided.
   */
  whenProvided(
    contractId: string,
    opts?: { scope?: BridgeScope; timeoutMs?: number },
  ): Promise<void> {
    const scope = opts?.scope ?? GLOBAL_SCOPE;
    const scopeKey = serializeScope(scope);
    const existing = this.resolve(contractId, scope);
    if (existing) return Promise.resolve();

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      const key = this._key(contractId, scopeKey);
      if (!this._readinessWaiters.has(key)) {
        this._readinessWaiters.set(key, []);
      }
      const timer = setTimeout(() => {
        const waiters = this._readinessWaiters.get(key);
        if (waiters) {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx !== -1) waiters.splice(idx, 1);
        }
        reject(
          new Error(
            `[bridgekit] CONTRACT_NOT_PROVIDED: contract '${contractId}' not provided in scope ${scopeKey} within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this._readinessWaiters.get(key)?.push({ resolve, reject, timer });
    });
  }

  /** Check if a contract is currently provided in a scope. */
  isProvided(contractId: string, scope?: BridgeScope): boolean {
    return this.resolve(contractId, scope ?? GLOBAL_SCOPE) !== undefined;
  }

  /** Subscribe to state changes for a (contractId, scope, key). Returns unsubscribe.
   * H-10: listeners are stored at registry level (keyed contractId|scopeKey|key) so
   * they survive provider swaps — a new provider binding notifies the same listener set.
   */
  subscribeState(
    contractId: string,
    scope: BridgeScope,
    key: string,
    cb: (value: unknown) => void,
  ): () => void {
    const scopeKey = serializeScope(scope);
    const sk = this._stateKey(contractId, scopeKey, key);
    if (!this._stateListeners.has(sk)) {
      this._stateListeners.set(sk, new Set());
    }
    this._stateListeners.get(sk)?.add(cb);
    return () => {
      this._stateListeners.get(sk)?.delete(cb);
    };
  }

  /** Get current state value. Returns undefined if not provided. */
  getState(contractId: string, scope: BridgeScope, key: string): unknown {
    const entry = this.resolve(contractId, scope);
    return entry?.state.get(key);
  }

  /** Hydrate state from connect snapshot. */
  hydrateState(contractId: string, scopeKey: string, key: string, value: unknown): void {
    // Find entry by exact scopeKey (snapshots are exact)
    for (const [k, entry] of this._entries) {
      if (k === this._key(contractId, scopeKey)) {
        entry.state.set(key, value);
        // H-10: notify registry-level listeners
        const sk = this._stateKey(contractId, scopeKey, key);
        const listeners = this._stateListeners.get(sk);
        if (listeners) {
          for (const cb of listeners) cb(value);
        }
        return;
      }
    }
  }

  /**
   * Close all live bindings with the given reason.
   * Called on reconnect/epoch-swap to clean up JS-provided bindings from the prior epoch.
   */
  closeAll(reason: 'replacing' | 'final' = 'final'): void {
    for (const [, entry] of this._entries) {
      if (entry.binding.isLive) {
        entry.binding.close(reason);
      }
    }
  }

  /** Dump all bindings (for diagnostics). */
  dump(): Array<{ contractId: string; scopeKey: string; isLive: boolean }> {
    return Array.from(this._entries.entries()).map(([, entry]) => ({
      contractId: entry.binding.contractId,
      scopeKey: entry.binding.scopeKey,
      isLive: entry.binding.isLive,
    }));
  }

  private _notifyReadiness(contractId: string, scopeKey: string): void {
    const key = this._key(contractId, scopeKey);
    const waiters = this._readinessWaiters.get(key);
    if (!waiters?.length) return;
    this._readinessWaiters.delete(key);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }
}

// ---- BridgeStreamSource helpers -------------------------------------------

import type { BridgeStreamSource } from '../contract/contract';

/**
 * Create a BridgeStreamSource from an emitter/teardown factory.
 * Usage: streamSource<string>((emit, end) => { ... return teardown; })
 */
export function streamSource<T>(
  factory: (
    emit: (v: T) => void,
    end: (result?: { ok: boolean; code?: string }) => void,
  ) => () => void,
): BridgeStreamSource<T> & { _onEnd?: () => void } {
  // Shared state across all subscribers
  const allValueListeners = new Set<(v: T) => void>();
  const allEndListeners = new Set<() => void>();
  let isEnded = false;
  let teardown: (() => void) | null = null;

  const emitValue = (v: T) => {
    if (isEnded) return;
    for (const cb of allValueListeners) cb(v);
  };
  const emitEnd = () => {
    if (isEnded) return;
    isEnded = true;
    for (const cb of allEndListeners) cb();
  };

  return {
    subscribe(cb: (v: T) => void): () => void {
      allValueListeners.add(cb);
      // Start the factory on first subscriber
      if (teardown === null && allValueListeners.size === 1) {
        teardown = factory(emitValue, emitEnd);
      }
      return () => {
        allValueListeners.delete(cb);
        if (allValueListeners.size === 0 && teardown) {
          teardown();
          teardown = null;
        }
      };
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const queue: T[] = [];
      const waiters: Array<(v: IteratorResult<T>) => void> = [];
      let done = isEnded;

      const valueCb = (v: T) => {
        if (waiters.length > 0) {
          const w = waiters.shift();
          if (w) w({ value: v, done: false });
        } else {
          queue.push(v);
        }
      };
      const endCb = () => {
        done = true;
        for (const w of waiters.splice(0)) {
          w({ value: undefined as unknown as T, done: true });
        }
      };

      allValueListeners.add(valueCb);
      allEndListeners.add(endCb);
      if (teardown === null && allValueListeners.size === 1) {
        teardown = factory(emitValue, emitEnd);
      }

      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            const val = queue.shift();
            return Promise.resolve({ value: val as T, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        return(): Promise<IteratorResult<T>> {
          done = true;
          allValueListeners.delete(valueCb);
          allEndListeners.delete(endCb);
          // Call teardown if this was the last listener (mirrors subscribe() cleanup)
          if (allValueListeners.size === 0 && teardown) {
            teardown();
            teardown = null;
          }
          const pending = waiters.splice(0);
          for (const w of pending) {
            w({ value: undefined as unknown as T, done: true });
          }
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        },
      };
    },
  };
}

/**
 * Wrap an AsyncIterable as a BridgeStreamSource.
 */
export function fromAsyncIterable<T>(iter: AsyncIterable<T>): BridgeStreamSource<T> {
  return {
    subscribe(cb: (v: T) => void): () => void {
      let active = true;
      (async () => {
        for await (const v of iter) {
          if (!active) break;
          cb(v);
        }
      })().catch(() => {});
      return () => {
        active = false;
      };
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return iter[Symbol.asyncIterator]();
    },
  };
}
