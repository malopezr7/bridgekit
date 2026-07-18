// Registry — bindings keyed by (contractId, scopeKey).
// Resolution walks instance → feature → global.

import type { BridgeContract } from '../contract/contract';
import type { BridgeScope } from '../contract/protocol';
import { diagnostics } from './diagnostics';
import { isBridgeKitDev } from './env';

// ---- scope serialization --------------------------------------------------

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
  /** Per-key state values */
  state: Map<string, unknown>;
}

interface BindingCloseEvent {
  binding: Binding;
  contractId: string;
  scope: BridgeScope;
  reason?: 'replacing' | 'final';
}

type ReadinessChangeListener = (event: {
  contractId: string;
  scope: BridgeScope;
  provided: boolean;
}) => void;

interface ReplacingWaiter {
  requestedScope: BridgeScope;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface ReplacingTombstone {
  contractId: string;
  owner: Binding;
  pendingCallers: ReplacingWaiter[];
  graceTimer: ReturnType<typeof setTimeout>;
}

// ---- Readiness waiters -----------------------------------------------------

interface ReadinessWaiter {
  contractId: string;
  scope: BridgeScope;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---- Registry constants ---------------------------------------------------

export const DEFAULT_READINESS_TIMEOUT_MS = 5000;
const DEFAULT_GRACE_WINDOW_MS = 1500;

// ---- Registry -------------------------------------------------------------

export class Registry {
  private readonly _entries = new Map<string, RegistryEntry>();
  private readonly _replacingTombstones = new Map<string, ReplacingTombstone>();
  private readonly _readinessWaiters = new Map<string, ReadinessWaiter[]>();
  // Registry-level state listeners survive provider swaps — never cleared by an entry close.
  private readonly _stateListeners = new Map<string, Set<(value: unknown) => void>>();
  private readonly _closeListeners = new Set<(event: BindingCloseEvent) => void>();
  private readonly _readinessListeners = new Set<ReadinessChangeListener>();

  private _key(contractId: string, scopeKey: string): string {
    return `${contractId}|${scopeKey}`;
  }

  private _stateKey(contractId: string, scopeKey: string, key: string): string {
    return `${contractId}|${scopeKey}|${key}`;
  }

  private _candidateScopeKeys(scope: BridgeScope): string[] {
    if (scope.kind === 'instance') {
      return [
        serializeScope(scope),
        serializeScope({ kind: 'feature', feature: scope.feature }),
        'global',
      ];
    }
    if (scope.kind === 'feature') {
      return [serializeScope(scope), 'global'];
    }
    return ['global'];
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
      if (isBridgeKitDev()) {
        console.warn(
          `[bridgekit] provide(${contractId}, ${scopeKey}): superseding existing binding.`,
        );
      }
      existing.binding.isLive = false;
    }

    const entry: RegistryEntry = {
      binding: null as unknown as Binding, // filled below
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
        const sk = this._stateKey(contractId, scopeKey, key);
        const listeners = this._stateListeners.get(sk);
        if (listeners) {
          for (const cb of listeners) {
            cb(value);
          }
        }
      },
      close: (reason?: 'replacing' | 'final') => {
        if (!binding.isLive) {
          if (reason === 'final') {
            this._finalizeReplacingTombstone(entryKey, binding);
          }
          return;
        }
        binding.isLive = false;
        this._entries.delete(entryKey);

        if (reason === 'replacing') {
          const pendingCallers: ReplacingTombstone['pendingCallers'] = [];
          const graceTimer = setTimeout(() => {
            const tombstone = this._replacingTombstones.get(entryKey);
            if (!tombstone) return;
            this._replacingTombstones.delete(entryKey);
            const pending = tombstone.pendingCallers.splice(0);
            for (const w of pending) {
              if (this.resolve(contractId, w.requestedScope)) {
                w.resolve();
              } else {
                w.reject(new Error('CONTRACT_NOT_PROVIDED'));
              }
            }
          }, DEFAULT_GRACE_WINDOW_MS);
          // unref so the timer does not block Node.js process exit / test runner.
          (graceTimer as unknown as { unref?: () => void }).unref?.();
          this._replacingTombstones.set(entryKey, {
            contractId,
            owner: binding,
            pendingCallers,
            graceTimer,
          });
        } else {
          // final: fail immediately
          this._finalizeReplacingTombstone(entryKey);
          for (const [sk, listeners] of this._stateListeners) {
            if (sk.startsWith(`${contractId}|${scopeKey}|`)) {
              for (const cb of listeners) {
                cb(undefined);
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
        this._notifyClose({ binding, contractId, scope, reason });
        this._notifyReadinessChange({ contractId, scope, provided: false });
      },
    };

    entry.binding = binding;
    this._entries.set(entryKey, entry);

    this._wakeReplacingWaiters();

    // Resolve any readiness waiters
    this._notifyReadiness(contractId, scopeKey);
    this._notifyReadinessChange({ contractId, scope, provided: true });

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
    for (const sk of this._candidateScopeKeys(scope)) {
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
        if (this.resolve(contractId, scope)) {
          resolve();
        } else {
          reject(
            new Error(
              `[bridgekit] CONTRACT_NOT_PROVIDED: contract '${contractId}' not provided in scope ${scopeKey} within ${timeoutMs}ms`,
            ),
          );
        }
      }, timeoutMs);

      this._readinessWaiters.get(key)?.push({ contractId, scope, resolve, reject, timer });
    });
  }

  /** Check if a contract is currently provided in a scope. */
  isProvided(contractId: string, scope?: BridgeScope): boolean {
    return this.resolve(contractId, scope ?? GLOBAL_SCOPE) !== undefined;
  }

  /**
   * Park on an exact replacing tombstone in the requested fallback chain.
   * Returns undefined when no tombstone should win, so callers can use their
   * normal not-provided behavior. Wider live fallbacks always take precedence.
   */
  whenReplacingProvided(contractId: string, scope: BridgeScope): Promise<void> | undefined {
    if (this.resolve(contractId, scope)) return undefined;
    for (const scopeKey of this._candidateScopeKeys(scope)) {
      const tombstone = this._replacingTombstones.get(this._key(contractId, scopeKey));
      if (!tombstone) continue;
      return new Promise<void>((resolve, reject) => {
        tombstone.pendingCallers.push({ requestedScope: scope, resolve, reject });
      });
    }
    return undefined;
  }

  /** Subscribe to state changes for a (contractId, scope, key). Returns unsubscribe.
   * Listeners are stored at registry level so they survive provider swaps.
   */
  subscribeState(
    contractId: string,
    scope: BridgeScope,
    key: string,
    cb: (value: unknown) => void,
  ): () => void {
    const scopeKey = this.resolve(contractId, scope)?.binding.scopeKey ?? serializeScope(scope);
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
    for (const [, entry] of Array.from(this._entries)) {
      if (entry.binding.isLive) {
        entry.binding.close(reason);
      }
    }
    if (reason === 'final') {
      for (const key of Array.from(this._replacingTombstones.keys())) {
        this._finalizeReplacingTombstone(key);
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

  onBindingClose(listener: (event: BindingCloseEvent) => void): () => void {
    this._closeListeners.add(listener);
    return () => {
      this._closeListeners.delete(listener);
    };
  }

  onReadinessChange(listener: ReadinessChangeListener): () => void {
    this._readinessListeners.add(listener);
    return () => {
      this._readinessListeners.delete(listener);
    };
  }

  private _notifyClose(event: BindingCloseEvent): void {
    for (const listener of this._closeListeners) {
      listener(event);
    }
  }

  private _notifyReadinessChange(event: {
    contractId: string;
    scope: BridgeScope;
    provided: boolean;
  }): void {
    for (const listener of this._readinessListeners) {
      try {
        listener(event);
      } catch {
        // Readiness listeners are observers; one failed observer must not abort registry mutation.
      }
    }
  }

  private _notifyReadiness(contractId: string, scopeKey: string): void {
    for (const [key, waiters] of this._readinessWaiters) {
      const pending: ReadinessWaiter[] = [];
      for (const waiter of waiters) {
        const canResolve =
          waiter.contractId === contractId &&
          this._candidateScopeKeys(waiter.scope).includes(scopeKey);
        if (canResolve) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        } else {
          pending.push(waiter);
        }
      }
      if (pending.length > 0) {
        this._readinessWaiters.set(key, pending);
      } else {
        this._readinessWaiters.delete(key);
      }
    }
  }

  private _wakeReplacingWaiters(): void {
    for (const [key, tombstone] of Array.from(this._replacingTombstones)) {
      const pending: ReplacingWaiter[] = [];
      for (const waiter of tombstone.pendingCallers) {
        if (this.resolve(tombstone.contractId, waiter.requestedScope)) {
          waiter.resolve();
        } else {
          pending.push(waiter);
        }
      }
      if (this._entries.has(key)) {
        this._replacingTombstones.delete(key);
        clearTimeout(tombstone.graceTimer);
      } else if (pending.length > 0) {
        tombstone.pendingCallers.splice(0, tombstone.pendingCallers.length, ...pending);
      } else {
        tombstone.pendingCallers.splice(0);
      }
    }
  }

  private _finalizeReplacingTombstone(entryKey: string, owner?: Binding): void {
    const tombstone = this._replacingTombstones.get(entryKey);
    if (!tombstone) return;
    if (owner && tombstone.owner !== owner) return;
    this._replacingTombstones.delete(entryKey);
    clearTimeout(tombstone.graceTimer);
    const pending = tombstone.pendingCallers.splice(0);
    for (const waiter of pending) {
      waiter.reject(new Error('CONTRACT_NOT_PROVIDED'));
    }
  }
}

import type { BridgeStreamSource } from '../contract/contract';
import {
  type BridgeError,
  type BridgeErrorCode,
  type BridgeStreamSubscribeOptions,
  createBridgeError,
  ERROR_CODES,
  isBridgeError,
} from '../contract/protocol';

function reportLocalStreamCallbackError(kind: string, error: unknown): void {
  diagnostics.incrementErrors();
  const message = error instanceof Error ? error.message : String(error);
  diagnostics.warnOnce(
    `local-stream-callback:${kind}`,
    `local stream ${kind} callback threw: ${message}`,
  );
}

function localStreamError(result: { ok: boolean; code?: string }): BridgeError | null {
  if (result.ok) return null;
  const code = (ERROR_CODES as readonly string[]).includes(result.code ?? '')
    ? (result.code as BridgeErrorCode)
    : 'PROVIDER_ERROR';
  return createBridgeError(code, `[bridgekit] local stream ended with ${code}`);
}

/**
 * Create a BridgeStreamSource from an emitter/teardown factory.
 * Usage: streamSource<string>((emit, end) => { ... return teardown; })
 */
export function streamSource<T>(
  factory: (
    emit: (v: T) => void,
    end: (result?: { ok: boolean; code?: string }) => void,
  ) => () => void,
): BridgeStreamSource<T> & { _isSettled: () => boolean; _onEnd?: () => void } {
  // Shared state across all subscribers
  const allValueListeners = new Set<(v: T) => void>();
  const allEndListeners = new Set<(error: BridgeError | null) => void>();
  let isEnded = false;
  let terminalError: BridgeError | null = null;
  let teardown: (() => void) | null = null;

  const emitValue = (v: T) => {
    if (isEnded) return;
    for (const cb of allValueListeners) cb(v);
  };
  const emitEnd = (result: { ok: boolean; code?: string } = { ok: true }) => {
    if (isEnded) return;
    isEnded = true;
    terminalError = localStreamError(result);
    const endListeners = Array.from(allEndListeners);
    allValueListeners.clear();
    allEndListeners.clear();
    for (const cb of endListeners) {
      try {
        cb(terminalError);
      } catch (error) {
        reportLocalStreamCallbackError('terminal', error);
      }
    }
  };

  const startFactory = () => {
    const nextTeardown = factory(emitValue, emitEnd);
    if (isEnded) nextTeardown();
    else teardown = nextTeardown;
  };

  return {
    _isSettled: () => isEnded,
    subscribe(cb: (v: T) => void, options?: BridgeStreamSubscribeOptions): () => void {
      if (isEnded) {
        try {
          if (terminalError !== null) options?.onError?.(terminalError);
          else options?.onComplete?.();
        } catch (error) {
          reportLocalStreamCallbackError(terminalError !== null ? 'onError' : 'onComplete', error);
        }
        return () => {};
      }
      allValueListeners.add(cb);
      const endCb = (error: BridgeError | null) => {
        try {
          if (error !== null) options?.onError?.(error);
          else options?.onComplete?.();
        } catch (callbackError) {
          reportLocalStreamCallbackError(error !== null ? 'onError' : 'onComplete', callbackError);
        }
      };
      allEndListeners.add(endCb);
      if (teardown === null && allValueListeners.size === 1) {
        startFactory();
      }
      return () => {
        allValueListeners.delete(cb);
        allEndListeners.delete(endCb);
        if (allValueListeners.size === 0 && teardown) {
          teardown();
          teardown = null;
        }
      };
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const queue: T[] = [];
      const waiters: Array<{
        resolve: (v: IteratorResult<T>) => void;
        reject: (error: BridgeError) => void;
      }> = [];
      let done = isEnded;
      let returned = false;
      let iteratorError = terminalError;

      const valueCb = (v: T) => {
        if (waiters.length > 0) {
          const w = waiters.shift();
          if (w) w.resolve({ value: v, done: false });
        } else {
          queue.push(v);
        }
      };
      const endCb = (error: BridgeError | null) => {
        done = true;
        iteratorError = error;
        if (error !== null) queue.length = 0;
        for (const w of waiters.splice(0)) {
          if (error !== null) w.reject(error);
          else w.resolve({ value: undefined as unknown as T, done: true });
        }
      };

      if (!isEnded) {
        allValueListeners.add(valueCb);
        allEndListeners.add(endCb);
        if (teardown === null && allValueListeners.size === 1) {
          startFactory();
        }
      }

      return {
        next(): Promise<IteratorResult<T>> {
          if (returned) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          if (iteratorError !== null) return Promise.reject(iteratorError);
          if (queue.length > 0) {
            const val = queue.shift();
            return Promise.resolve({ value: val as T, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        return(): Promise<IteratorResult<T>> {
          if (returned) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          returned = true;
          done = true;
          queue.length = 0;
          allValueListeners.delete(valueCb);
          allEndListeners.delete(endCb);
          if (allValueListeners.size === 0 && teardown) {
            teardown();
            teardown = null;
          }
          const pending = waiters.splice(0);
          for (const w of pending) {
            w.resolve({ value: undefined as unknown as T, done: true });
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
    subscribe(cb: (v: T) => void, options?: BridgeStreamSubscribeOptions): () => void {
      let active = true;
      (async () => {
        for await (const v of iter) {
          if (!active) break;
          cb(v);
        }
        if (active) {
          try {
            options?.onComplete?.();
          } catch (callbackError) {
            reportLocalStreamCallbackError('onComplete', callbackError);
          }
        }
      })().catch((error: unknown) => {
        if (!active) return;
        const bridgeError = isBridgeError(error)
          ? error
          : createBridgeError(
              'PROVIDER_ERROR',
              error instanceof Error ? error.message : String(error),
            );
        try {
          options?.onError?.(bridgeError);
        } catch (callbackError) {
          reportLocalStreamCallbackError('onError', callbackError);
        }
      });
      return () => {
        active = false;
      };
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return iter[Symbol.asyncIterator]();
    },
  };
}
