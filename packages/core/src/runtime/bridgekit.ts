// BridgeKitJs — main JS-side bridge instance.
// Wires transport + dispatcher + registry + mirrors + typed proxy.

import { decode, encode, sanitizeAny, validate } from '../contract/codec';
import type { BridgeContract, BridgeStreamSource } from '../contract/contract';
import { isMarkerDescriptor } from '../contract/contract';
import type { BridgeScope } from '../contract/protocol';
import { createBridgeError } from '../contract/protocol';
import type { AnySchema } from '../contract/schema';
import { nextCorrelationId } from './correlationId';
import { diagnostics } from './diagnostics';
import { Dispatcher } from './dispatcher';
import { isBridgeKitDev } from './env';
import {
  invokeLocalAsync,
  invokeLocalFire,
  invokeLocalSync,
  openLocalStream,
} from './localInvoker';
import type { Binding } from './registry';
import { DEFAULT_READINESS_TIMEOUT_MS, GLOBAL_SCOPE, Registry, serializeScope } from './registry';
import type { StateMirror } from './stateMirror';
import { LocalStateMirror, MirrorRegistry, NativeReadinessMirror } from './stateMirror';
import type { BridgeTransport } from './transport';

/**
 * Encode method params for transport.
 * t.* path: schema-driven encode. Marker path (no params schema): deep-sanitize.
 */
function _encodePayload(
  methodDesc: import('../contract/contract').MethodDescriptor,
  params: unknown,
): unknown {
  if (params === undefined) return undefined;
  if ('params' in methodDesc && methodDesc.params) {
    return encode(methodDesc.params, params);
  }
  // Marker path: no schema → universal sanitize (strips undefined/functions)
  return sanitizeAny(params);
}

/**
 * Decode an inbound native payload against its schema, then validate it.
 * Validation runs on the inbound seam: wire skew is a production concern. A mismatch
 * throws VALIDATION_FAILED with the field path instead of silently coercing.
 */
function _decodeAndValidateInbound(
  schema: AnySchema,
  value: unknown,
  contractId: string,
  member: string,
): unknown {
  const decoded = decode(schema, value);
  const result = validate(schema, decoded);
  if (!result.ok) {
    throw createBridgeError(
      'VALIDATION_FAILED',
      `[bridgekit] VALIDATION_FAILED: ${contractId}.${member} result ${result.message} at path "${result.path}"`,
      { contractId, member, details: { path: result.path } },
    );
  }
  return decoded;
}

function _encodeStateValue(
  schema: AnySchema,
  value: unknown,
  contractId: string,
  member: string,
): unknown {
  if (value === undefined) {
    throw createBridgeError(
      'VALIDATION_FAILED',
      `[bridgekit] setState VALIDATION_FAILED: ${contractId}.${member} top-level undefined is reserved for provider removal`,
      { contractId, member, details: { path: '' } },
    );
  }
  const result = validate(schema, value);
  if (!result.ok) {
    throw createBridgeError(
      'VALIDATION_FAILED',
      `[bridgekit] setState VALIDATION_FAILED: ${contractId}.${member} ${result.message} at path "${result.path}"`,
      { contractId, member, details: { path: result.path } },
    );
  }
  try {
    return encode(schema, value);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw createBridgeError(
      'VALIDATION_FAILED',
      `[bridgekit] setState VALIDATION_FAILED: ${contractId}.${member} encode failed: ${cause}`,
      { contractId, member, details: { cause } },
    );
  }
}

function _encodeBridgeError(err: unknown, contractId: string, member: string, scope: BridgeScope) {
  const message = err instanceof Error ? err.message : String(err);
  return createBridgeError(
    'INCOMPATIBLE_CONTRACT',
    `[bridgekit] INCOMPATIBLE_CONTRACT: ${contractId}.${member} payload encode failed: ${message}`,
    { contractId, member, scope, details: { cause: message } },
  );
}

/**
 * Encode stream params for transport.
 * t.* path: schema-driven encode. Marker path: deep-sanitize.
 */
function _encodeStreamPayload(
  streamDesc: import('../contract/contract').StreamDescriptor,
  params: unknown,
): unknown {
  if (params === undefined) return undefined;
  if ('params' in streamDesc && streamDesc.params) {
    return encode(streamDesc.params, params);
  }
  return sanitizeAny(params);
}

/**
 * Wraps a BridgeStreamSource to track active subscription count in diagnostics.
 */
function wrapStreamSourceWithDiagnostics(
  source: BridgeStreamSource<unknown>,
): BridgeStreamSource<unknown> {
  return {
    subscribe(cb: (v: unknown) => void): () => void {
      diagnostics.incrementOpenStreams();
      const unsub = source.subscribe(cb);
      return () => {
        diagnostics.decrementOpenStreams();
        unsub();
      };
    },
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      diagnostics.incrementOpenStreams();
      const iter = source[Symbol.asyncIterator]();
      return {
        next(): Promise<IteratorResult<unknown>> {
          return iter.next();
        },
        return(value?: unknown): Promise<IteratorResult<unknown>> {
          diagnostics.decrementOpenStreams();
          return iter.return
            ? iter.return(value)
            : Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

// ---- Ambient scope --------------------------------------------------------

let _ambientScope: BridgeScope = GLOBAL_SCOPE;

export function setAmbientScope(scope: BridgeScope): void {
  _ambientScope = scope;
}

export function getAmbientScope(): BridgeScope {
  return _ambientScope;
}

// ---- BridgeCallOpts -------------------------------------------------------

export interface BridgeCallOpts {
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

interface ProviderRecord<TShape = unknown> {
  contract: BridgeContract<TShape>;
  impl: Partial<TShape>;
  scope: BridgeScope;
  binding: Binding | null;
  facade: ProviderFacade | null;
  stateValues: Map<string, unknown>;
}

type ProviderFacade = Binding & { _replaceBinding(binding: Binding): void };

function createProviderFacade(binding: Binding): ProviderFacade {
  let current = binding;
  return {
    contractId: binding.contractId,
    scope: binding.scope,
    scopeKey: binding.scopeKey,
    impl: binding.impl,
    get isLive() {
      return current.isLive;
    },
    set isLive(value: boolean) {
      current.isLive = value;
    },
    setState(key: string, value: unknown) {
      current.setState(key, value);
    },
    close(reason?: 'replacing' | 'final') {
      current.close(reason);
    },
    _replaceBinding(next: Binding) {
      current = next;
    },
  };
}

function candidateScopeKeys(scope: BridgeScope): string[] {
  // Keep in sync with Registry._candidateScopeKeys. Duplicated here to avoid
  // pushing registry-private fallback resolution into the BridgeKit facade layer.
  if (scope.kind === 'instance') {
    return [
      serializeScope(scope),
      serializeScope({ kind: 'feature', feature: scope.feature }),
      'global',
    ];
  }
  if (scope.kind === 'feature') return [serializeScope(scope), 'global'];
  return ['global'];
}

// ---- BridgeKitJs ----------------------------------------------------------

export class BridgeKitJs {
  readonly registry: Registry;
  readonly nativeReadiness: NativeReadinessMirror;
  private readonly _mirrors: MirrorRegistry;
  private readonly _dispatcher: Dispatcher;
  private readonly _contracts = new Map<string, BridgeContract<unknown>>();
  private readonly _providerRecords = new Map<string, ProviderRecord>();
  private _epoch = 0;
  private _connected = false;
  private _closingForEpochSwap = false;
  private _replayingProviders = false;
  private readonly _readinessVersionByScope = new Map<string, number>();

  constructor(private readonly _transport: BridgeTransport) {
    this.registry = new Registry();
    this.nativeReadiness = new NativeReadinessMirror();
    this._mirrors = new MirrorRegistry();
    this._dispatcher = new Dispatcher(this.registry, this._contracts, {
      nativeReadiness: this.nativeReadiness,
      getEpoch: () => this._epoch,
    });
    this.registry.onReadinessChange((event) => {
      this._bumpReadinessVersion(event.contractId, serializeScope(event.scope));
    });
    this.nativeReadiness.subscribe((record) => {
      this._bumpReadinessVersion(record.contractId, record.scopeKey);
    });
  }

  private _bumpReadinessVersion(contractId: string, scopeKey: string): void {
    const key = `${contractId}|${scopeKey}`;
    this._readinessVersionByScope.set(key, (this._readinessVersionByScope.get(key) ?? 0) + 1);
  }

  /**
   * Wire the dispatcher to the transport.
   * Call once on startup (or on reconnect / epoch-swap).
   *
   * On reconnect: tears down all prior-epoch state before re-wiring so no
   * producers, mirrors, or observers leak across epoch boundaries (W2-1).
   */
  connect(): void {
    const wasConnected = this._connected;
    const replayRecords = wasConnected ? Array.from(this._providerRecords.values()) : [];
    let quietDetached = new Set<string>();

    if (wasConnected) {
      // Reconnect: clean up prior-epoch resources before re-wiring.
      this._dispatcher.closeAllProducers();
      quietDetached = this._mirrors.detachAll({ notify: false });
      this._closingForEpochSwap = true;
      try {
        this.registry.closeAll('replacing');
      } finally {
        this._closingForEpochSwap = false;
      }
    }

    this._dispatcher.setTransport(this._transport);
    try {
      this._dispatcher.beginReadinessHydration();
      const result = this._transport.connect(this._dispatcher);
      this._epoch = result.epoch;
      this._connected = true;

      for (const entry of result.snapshot) {
        const stub = {
          descriptor: { id: entry.contractId, methods: {}, streams: {}, state: {} },
          hash: '',
        } as unknown as BridgeContract<unknown>;
        this._mirrors.getOrCreate(stub, entry.key, entry.scope, entry.value).hydrate(entry.value);
        quietDetached.delete(this._mirrors.keyFor(entry.contractId, entry.key, entry.scope));
      }

      this.nativeReadiness.hydrate(result.nativeProvided ?? []);
      this._dispatcher.endReadinessHydration();
    } catch (err) {
      this._dispatcher.abortReadinessHydration();
      throw err;
    }

    this._mirrors.attachAll(this._transport);

    this._replayingProviders = true;
    try {
      for (const record of replayRecords) {
        this.provide(record.contract, record.impl, { scope: record.scope });
      }
    } finally {
      this._replayingProviders = false;
    }
    for (const record of replayRecords) {
      if (!record.binding?.isLive) continue;
      for (const key of Object.keys(record.contract.descriptor.state)) {
        quietDetached.delete(
          this._mirrors.keyFor(record.contract.descriptor.id, key, record.scope),
        );
      }
    }
    this._mirrors.notifyNotProvided(quietDetached);
  }

  /**
   * Register a contract + implementation as a JS provider.
   */
  provide<TShape>(
    contract: BridgeContract<TShape>,
    impl: Partial<TShape>,
    opts?: { scope?: BridgeScope },
  ): Binding {
    const scope = opts?.scope ?? _ambientScope;
    const recordKey = `${contract.descriptor.id}|${serializeScope(scope)}`;
    let record = this._providerRecords.get(recordKey);
    const isReplay = this._replayingProviders;

    // JD2-001: pre-encode every initial wire value BEFORE mutating the contract
    // map, provider records, or registry. A failing encode must reject the
    // whole provide() atomically instead of leaving a live zombie binding and
    // partial pushes behind. Top-level undefined (valid for optional initials)
    // stays reserved for provider removal on the wire, so it is registered
    // locally but never pushed.
    const preserveReplayValues = isReplay && record !== undefined;
    const initialPushes: Array<{ key: string; value: unknown; transportValue: unknown }> = [];
    for (const [key, stateDesc] of Object.entries(contract.descriptor.state)) {
      const value =
        preserveReplayValues && record?.stateValues.has(key)
          ? record.stateValues.get(key)
          : 'initial' in stateDesc
            ? stateDesc.initial
            : undefined;
      if (value === undefined) {
        initialPushes.push({ key, value, transportValue: undefined });
        continue;
      }
      const transportValue =
        'value' in stateDesc && stateDesc.value
          ? _encodeStateValue(stateDesc.value, value, contract.descriptor.id, key)
          : value;
      initialPushes.push({ key, value, transportValue });
    }

    this._contracts.set(contract.descriptor.id, contract as BridgeContract<unknown>);
    const resetStateValues = (target: ProviderRecord) => {
      target.stateValues.clear();
      for (const [key, stateDesc] of Object.entries(contract.descriptor.state)) {
        target.stateValues.set(key, 'initial' in stateDesc ? stateDesc.initial : undefined);
      }
    };
    if (!record) {
      record = {
        contract: contract as BridgeContract<unknown>,
        impl: impl as Partial<unknown>,
        scope,
        binding: null,
        facade: null,
        stateValues: new Map(),
      };
      resetStateValues(record);
      this._providerRecords.set(recordKey, record);
    } else {
      record.contract = contract as BridgeContract<unknown>;
      record.impl = impl as Partial<unknown>;
      record.scope = scope;
      if (!isReplay) {
        resetStateValues(record);
        record.facade = null;
      }
    }
    const binding = this.registry.provide(contract, impl, { scope });
    record.binding = binding;

    const transport = this._transport;
    const wrappedBinding = binding as Binding & { _statePatched: boolean };
    if (!wrappedBinding._statePatched) {
      wrappedBinding._statePatched = true;
      const originalSetState = binding.setState.bind(binding);
      const originalClose = binding.close.bind(binding);

      binding.setState = (key: string, value: unknown) => {
        if (!binding.isLive && record.binding !== binding) return;
        const stateDesc = contract.descriptor.state[key];
        let transportValue = value;
        if (stateDesc !== undefined && 'value' in stateDesc && stateDesc.value) {
          transportValue = _encodeStateValue(stateDesc.value, value, contract.descriptor.id, key);
        }
        record.stateValues.set(key, value);
        originalSetState(key, value);
        transport.pushProviderState(contract.descriptor.id, scope, key, transportValue);
      };

      binding.close = (reason?: 'replacing' | 'final') => {
        // Capture live-ness BEFORE originalClose sets isLive=false.
        // A stale handle must NOT push unprovide side-effects that corrupt the live provider.
        const wasLive = binding.isLive;
        originalClose(reason);
        if (!wasLive) return; // stale close: no-op on transport
        if (this._closingForEpochSwap) {
          // Internal epoch swap: the provider record survives and is replayed into
          // the new epoch. Public close('replacing') below remains a real unregister.
          return;
        }
        record.binding = null;
        this._providerRecords.delete(recordKey);
        for (const key of Object.keys(contract.descriptor.state)) {
          transport.pushProviderState(contract.descriptor.id, scope, key, undefined);
        }
        // Always send unprovide so native marks the contract gone even if stateless.
        transport.announceUnprovided(contract.descriptor.id, scope);
      };

      // Push preserved provider-owned state so reconnect replay keeps registry,
      // native transport, and existing local mirrors coherent across epochs.
      // Values and wire encodings were precomputed before any mutation (JD2-001).
      for (const { key, value, transportValue } of initialPushes) {
        record.stateValues.set(key, value);
        originalSetState(key, value);
        if (value === undefined) continue; // reserved for provider removal — never pushed
        transport.pushProviderState(contract.descriptor.id, scope, key, transportValue);
      }

      // Explicit provide announcement — covers stateless contracts that send no stateWrite.
      // Idempotent on the native side. Must come AFTER initial state pushes.
      transport.announceProvided(contract.descriptor.id, scope);
    }

    if (record.facade && isReplay) {
      record.facade._replaceBinding(binding);
    }
    if (!record.facade) {
      record.facade = createProviderFacade(binding);
    }

    return record.facade;
  }

  /**
   * Get a typed consumer proxy for a contract.
   */
  bridge<TShape>(contract: BridgeContract<TShape>, opts?: { scope?: BridgeScope }): TShape {
    this._contracts.set(contract.descriptor.id, contract as BridgeContract<unknown>);
    const scope = opts?.scope ?? _ambientScope;
    const desc = contract.descriptor;

    return new Proxy({} as object, {
      get: (_target, prop: string | symbol) => {
        if (typeof prop !== 'string') return undefined;
        // Methods
        const methodDesc = desc.methods[prop];
        if (methodDesc) {
          if (methodDesc.kind === 'fire') {
            return (params?: unknown) => {
              // --- LOCAL-FIRST: check registry before transport ---
              const localEntry = this.registry.resolve(desc.id, scope);
              if (localEntry) {
                invokeLocalFire(localEntry.binding.impl, prop, desc.id, params);
                return;
              }
              // --- FALL-THROUGH: transport path ---
              let payload: unknown;
              try {
                payload = _encodePayload(methodDesc, params);
              } catch (err) {
                diagnostics.incrementFiresDropped();
                if (isBridgeKitDev()) {
                  console.warn(
                    `[bridgekit] fire ${desc.id}.${prop} dropped: ${_encodeBridgeError(err, desc.id, prop, scope).message}`,
                  );
                }
                return;
              }
              const env = {
                op: 'invoke' as const,
                contractId: desc.id,
                member: prop,
                scope,
                payload,
                correlationId: nextCorrelationId(),
                epoch: this._epoch,
                contractHash: contract.hash,
              };
              this._transport
                .invoke(env)
                .then((res) => {
                  if (!res.ok) {
                    diagnostics.incrementFiresDropped();
                    if (isBridgeKitDev()) {
                      console.warn(`[bridgekit] fire ${desc.id}.${prop} failed: ${res.code}`);
                    }
                  }
                })
                .catch(() => {
                  diagnostics.incrementFiresDropped();
                });
            };
          }

          if (methodDesc.kind === 'querySync') {
            return (params?: unknown, _opts?: BridgeCallOpts) => {
              const localEntry = this.registry.resolve(desc.id, scope);
              if (localEntry) {
                return invokeLocalSync(localEntry.binding.impl, prop, desc.id, params);
              }
              let payload: unknown;
              try {
                payload = _encodePayload(methodDesc, params);
              } catch (err) {
                throw _encodeBridgeError(err, desc.id, prop, scope);
              }
              const env = {
                op: 'invokeSync' as const,
                contractId: desc.id,
                member: prop,
                scope,
                payload,
                correlationId: nextCorrelationId(),
                epoch: this._epoch,
                contractHash: contract.hash,
              };
              const result = this._transport.invokeSync(env);
              if (!result.ok) {
                throw createBridgeError(result.code, result.message, {
                  contractId: result.contractId,
                  member: result.member,
                  scope: result.scope,
                  details: result.details,
                });
              }
              if ('result' in methodDesc && methodDesc.result) {
                // A non-void, non-optional result must carry a value.
                // undefined means the provider encoded nothing — likely a codegen mismatch.
                const schema = methodDesc.result;
                if (
                  result.value === undefined &&
                  schema.kind !== 'void' &&
                  schema.kind !== 'optional'
                ) {
                  throw createBridgeError(
                    'INCOMPATIBLE_CONTRACT',
                    `[bridgekit] provider returned no value for member '${prop}' (contractId: ${desc.id}) — likely a codegen/contract mismatch`,
                  );
                }
                return _decodeAndValidateInbound(schema, result.value, desc.id, prop);
              }
              if (isMarkerDescriptor(methodDesc as unknown as Record<string, unknown>)) {
                if (result.value === undefined) {
                  throw createBridgeError(
                    'INCOMPATIBLE_CONTRACT',
                    `[bridgekit] provider returned no value for member '${prop}' (contractId: ${desc.id}) — likely a codegen/contract mismatch`,
                  );
                }
              }
              return result.value;
            };
          }

          // query
          return (...args: unknown[]) => {
            let params: unknown;
            let callOpts: BridgeCallOpts | undefined;
            if (methodDesc.params) {
              params = args[0];
              callOpts = args[1] as BridgeCallOpts | undefined;
            } else if (isMarkerDescriptor(methodDesc as unknown as Record<string, unknown>)) {
              // Marker: no params schema — distinguish params from opts heuristically.
              const firstArg = args[0];
              if (
                firstArg !== undefined &&
                firstArg !== null &&
                typeof firstArg === 'object' &&
                !('timeoutMs' in (firstArg as Record<string, unknown>)) &&
                !('signal' in (firstArg as Record<string, unknown>))
              ) {
                params = firstArg;
                callOpts = args[1] as BridgeCallOpts | undefined;
              } else {
                callOpts = firstArg as BridgeCallOpts | undefined;
              }
            } else {
              callOpts = args[0] as BridgeCallOpts | undefined;
            }

            const localEntry = this.registry.resolve(desc.id, scope);
            if (localEntry) {
              const timeoutMsLocal =
                callOpts?.timeoutMs !== undefined
                  ? callOpts.timeoutMs
                  : 'timeoutMs' in methodDesc
                    ? methodDesc.timeoutMs
                    : undefined;
              return invokeLocalAsync(localEntry.binding.impl, prop, desc.id, params, {
                timeoutMs: timeoutMsLocal,
                signal: callOpts?.signal,
              });
            }

            let payload: unknown;
            try {
              payload = _encodePayload(methodDesc, params);
            } catch (err) {
              return Promise.reject(_encodeBridgeError(err, desc.id, prop, scope));
            }

            const env = {
              op: 'invoke' as const,
              contractId: desc.id,
              member: prop,
              scope,
              payload,
              correlationId: nextCorrelationId(),
              epoch: this._epoch,
              contractHash: contract.hash,
            };

            const timeoutMs =
              callOpts?.timeoutMs !== undefined
                ? callOpts.timeoutMs
                : 'timeoutMs' in methodDesc
                  ? methodDesc.timeoutMs
                  : undefined;

            let invocation = this._transport.invoke(env);

            let timerId: ReturnType<typeof setTimeout> | undefined;
            let abortHandler: (() => void) | undefined;
            let abortSignal: AbortSignal | undefined;

            if (timeoutMs !== undefined && timeoutMs !== null) {
              invocation = Promise.race([
                invocation,
                new Promise<typeof invocation extends Promise<infer R> ? R : never>((_, reject) => {
                  timerId = setTimeout(
                    () =>
                      reject(
                        createBridgeError(
                          'TIMEOUT',
                          `[bridgekit] TIMEOUT: ${desc.id}.${prop} exceeded ${timeoutMs}ms`,
                        ),
                      ),
                    timeoutMs,
                  );
                }),
              ]);
            }

            if (callOpts?.signal) {
              const signal = callOpts.signal;
              if (signal.aborted) {
                if (timerId !== undefined) clearTimeout(timerId);
                return Promise.reject(
                  createBridgeError(
                    'CANCELLED',
                    '[bridgekit] CANCELLED: AbortSignal already aborted',
                  ),
                );
              }
              abortSignal = signal;
              invocation = Promise.race([
                invocation,
                new Promise<typeof invocation extends Promise<infer R> ? R : never>((_, reject) => {
                  abortHandler = () =>
                    reject(
                      createBridgeError('CANCELLED', '[bridgekit] CANCELLED: AbortSignal aborted'),
                    );
                  signal.addEventListener('abort', abortHandler, { once: true });
                }),
              ]);
            }

            return invocation
              .finally(() => {
                if (timerId !== undefined) clearTimeout(timerId);
                if (abortSignal !== undefined && abortHandler !== undefined) {
                  abortSignal.removeEventListener('abort', abortHandler);
                }
              })
              .then((res) => {
                if (!res.ok) {
                  diagnostics.incrementErrors();
                  throw createBridgeError(res.code, res.message, {
                    contractId: res.contractId,
                    member: res.member,
                    scope: res.scope,
                    details: res.details,
                  });
                }
                if ('result' in methodDesc && methodDesc.result) {
                  // A non-void, non-optional result must carry a value.
                  const schema = methodDesc.result;
                  if (
                    res.value === undefined &&
                    schema.kind !== 'void' &&
                    schema.kind !== 'optional'
                  ) {
                    throw createBridgeError(
                      'INCOMPATIBLE_CONTRACT',
                      `[bridgekit] provider returned no value for member '${prop}' (contractId: ${desc.id}) — likely a codegen/contract mismatch`,
                    );
                  }
                  return _decodeAndValidateInbound(schema, res.value, desc.id, prop);
                }
                if (isMarkerDescriptor(methodDesc as unknown as Record<string, unknown>)) {
                  if (res.value === undefined) {
                    throw createBridgeError(
                      'INCOMPATIBLE_CONTRACT',
                      `[bridgekit] provider returned no value for member '${prop}' (contractId: ${desc.id}) — likely a codegen/contract mismatch`,
                    );
                  }
                }
                return res.value;
              });
          };
        }

        // Streams
        const streamDesc = desc.streams[prop];
        if (streamDesc) {
          return (params?: unknown): BridgeStreamSource<unknown> => {
            const localEntry = this.registry.resolve(desc.id, scope);
            if (localEntry) {
              const localSource = openLocalStream(localEntry.binding.impl, prop, desc.id, params);
              return wrapStreamSourceWithDiagnostics(localSource);
            }

            let preOpenError: ReturnType<typeof _encodeBridgeError> | null = null;
            let env: Parameters<BridgeTransport['openStream']>[0] | null = null;
            try {
              env = {
                op: 'streamOpen' as const,
                contractId: desc.id,
                member: prop,
                scope,
                payload: _encodeStreamPayload(streamDesc, params),
                correlationId: nextCorrelationId(),
                epoch: this._epoch,
                contractHash: contract.hash,
                ...(streamDesc.latestOnly === true ? { latestOnly: true } : {}),
                ...(streamDesc.sticky === true ? { sticky: true } : {}),
              };
            } catch (err) {
              preOpenError = _encodeBridgeError(err, desc.id, prop, scope);
            }

            let streamId: string | null = null;
            const subscribers = new Set<(v: unknown) => void>();
            // Notified when native closes the stream; async iterators register here
            // so pending next() calls resolve with { done: true }.
            const endSubscribers = new Set<() => void>();
            const capturedTransport = this._transport;

            const closeIfNeeded = () => {
              if (streamId !== null) {
                const id = streamId;
                streamId = null;
                capturedTransport.closeStream(id);
              }
            };

            const openIfNeeded = () => {
              if (preOpenError !== null || env === null) return;
              if (streamId !== null) return;
              streamId = capturedTransport.openStream(
                env,
                (value) => {
                  const decoded = streamDesc.value ? decode(streamDesc.value, value) : value;
                  for (const cb of subscribers) cb(decoded);
                },
                (_end) => {
                  streamId = null;
                  subscribers.clear();
                  // Notify async iterators so pending next() calls resolve done.
                  for (const cb of endSubscribers) cb();
                  endSubscribers.clear();
                },
              );
            };

            const transportSource: BridgeStreamSource<unknown> = {
              subscribe(cb: (v: unknown) => void): () => void {
                if (preOpenError !== null) {
                  diagnostics.incrementErrors();
                  if (isBridgeKitDev()) {
                    console.warn(
                      `[bridgekit] stream ${desc.id}.${prop} failed: ${preOpenError.message}`,
                    );
                  }
                  return () => {};
                }
                subscribers.add(cb);
                openIfNeeded();
                return () => {
                  subscribers.delete(cb);
                  if (subscribers.size === 0) {
                    closeIfNeeded();
                  }
                };
              },
              [Symbol.asyncIterator](): AsyncIterator<unknown> {
                if (preOpenError !== null) {
                  diagnostics.incrementErrors();
                  return {
                    next(): Promise<IteratorResult<unknown>> {
                      return Promise.reject(preOpenError);
                    },
                    return(): Promise<IteratorResult<unknown>> {
                      return Promise.resolve({ value: undefined, done: true });
                    },
                  };
                }
                // Bounded ring buffer with DROP_OLDEST backpressure.
                const QUEUE_CAPACITY = 64;
                const ringBuf = new Array<unknown>(QUEUE_CAPACITY);
                let head = 0; // index of next read
                let tail = 0; // index of next write
                let size = 0; // current item count
                const waiters: Array<(v: IteratorResult<unknown>) => void> = [];
                let closed = false;
                const iterCb = (v: unknown) => {
                  if (waiters.length > 0) {
                    const w = waiters.shift();
                    if (w) w({ value: v, done: false });
                  } else {
                    if (size === QUEUE_CAPACITY) {
                      // DROP_OLDEST: advance head to drop the oldest item
                      head = (head + 1) % QUEUE_CAPACITY;
                      diagnostics.incrementStreamDrops();
                    } else {
                      size++;
                    }
                    ringBuf[tail] = v;
                    tail = (tail + 1) % QUEUE_CAPACITY;
                  }
                };
                const iterEndCb = () => {
                  closed = true;
                  subscribers.delete(iterCb);
                  endSubscribers.delete(iterEndCb);
                  for (const w of waiters.splice(0)) w({ value: undefined, done: true });
                };
                subscribers.add(iterCb);
                endSubscribers.add(iterEndCb);
                openIfNeeded();
                return {
                  next(): Promise<IteratorResult<unknown>> {
                    if (size > 0) {
                      const value = ringBuf[head];
                      ringBuf[head] = undefined; // allow GC
                      head = (head + 1) % QUEUE_CAPACITY;
                      size--;
                      return Promise.resolve({ value, done: false });
                    }
                    if (closed) return Promise.resolve({ value: undefined, done: true });
                    return new Promise((resolve) => waiters.push(resolve));
                  },
                  return(): Promise<IteratorResult<unknown>> {
                    closed = true;
                    subscribers.delete(iterCb);
                    endSubscribers.delete(iterEndCb);
                    if (subscribers.size === 0) closeIfNeeded();
                    for (const w of waiters.splice(0)) w({ value: undefined, done: true });
                    return Promise.resolve({ value: undefined, done: true });
                  },
                };
              },
            };
            return wrapStreamSourceWithDiagnostics(transportSource);
          };
        }

        return undefined;
      },
    }) as unknown as TShape;
  }

  /**
   * Get a state mirror for a contract key.
   * Returns a LocalStateMirror for JS-local providers; transport-backed otherwise.
   */
  state(
    contract: BridgeContract<unknown>,
    key: string,
    scopeOverride?: BridgeScope,
  ): StateMirror<unknown> | LocalStateMirror<unknown> {
    this._contracts.set(contract.descriptor.id, contract as BridgeContract<unknown>);
    const stateDesc = contract.descriptor.state[key as string];
    // 'initial' in check distinguishes null (valid initial) from missing descriptor.
    const initial =
      stateDesc !== undefined && 'initial' in stateDesc ? stateDesc.initial : undefined;
    const scope = scopeOverride ?? _ambientScope;

    const localEntry = this.registry.resolve(contract.descriptor.id, scope);
    if (localEntry) {
      return new LocalStateMirror(this.registry, contract.descriptor.id, key, scope, initial);
    }

    const mirror = this._mirrors.getOrCreate(
      contract as BridgeContract<unknown>,
      key as string,
      scope,
      initial,
    ) as unknown as StateMirror<unknown>;
    if (this._connected) {
      mirror.attachTransport(this._transport);
    }
    return mirror;
  }

  /**
   * Check whether a contract is currently provided in the given scope.
   * Checks the JS-local registry first (no native round-trip needed).
   */
  isProvided(contract: BridgeContract<unknown>, opts?: { scope?: BridgeScope }): boolean {
    const scope = opts?.scope ?? _ambientScope;
    return (
      this.registry.isProvided(contract.descriptor.id, scope) ||
      this.nativeReadiness.isProvided(contract.descriptor.id, scope)
    );
  }

  /**
   * Await until a contract is provided in the given scope.
   *
   * Resolves immediately if already provided. Rejects with CONTRACT_NOT_PROVIDED
   * if no provider registers within the timeout window.
   */
  awaitProvided(
    contract: BridgeContract<unknown>,
    opts?: { scope?: BridgeScope; timeoutMs?: number },
  ): Promise<void> {
    const scope = opts?.scope ?? _ambientScope;
    if (this.isProvided(contract, { scope })) return Promise.resolve();

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribeRegistry: (() => void) | null = null;
      let unsubscribeNative: (() => void) | null = null;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        unsubscribeRegistry?.();
        unsubscribeNative?.();
        fn();
      };
      const check = () => {
        if (this.isProvided(contract, { scope })) {
          settle(resolve);
        }
      };

      unsubscribeRegistry = this.registry.onReadinessChange((event) => {
        if (event.contractId === contract.descriptor.id) check();
      });
      unsubscribeNative = this.nativeReadiness.subscribe((record) => {
        if (record.contractId === contract.descriptor.id) check();
      });
      timer = setTimeout(() => {
        settle(() => {
          reject(
            new Error(
              `[bridgekit] CONTRACT_NOT_PROVIDED: contract '${contract.descriptor.id}' not provided in scope ${serializeScope(scope)} within ${timeoutMs}ms`,
            ),
          );
        });
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      check();
    });
  }

  subscribeReadiness(
    contract: BridgeContract<unknown>,
    scope: BridgeScope,
    onStoreChange: () => void,
  ): () => void {
    const relevantScopeKeys = candidateScopeKeys(scope);
    const notifyIfRelevant = (contractId: string, scopeKey: string) => {
      if (contractId === contract.descriptor.id && relevantScopeKeys.includes(scopeKey)) {
        onStoreChange();
      }
    };
    const unsubscribeRegistry = this.registry.onReadinessChange((event) => {
      notifyIfRelevant(event.contractId, serializeScope(event.scope));
    });
    const unsubscribeNative = this.nativeReadiness.subscribe((record) => {
      notifyIfRelevant(record.contractId, record.scopeKey);
    });
    return () => {
      unsubscribeRegistry();
      unsubscribeNative();
    };
  }

  readinessSnapshot(contract: BridgeContract<unknown>, scope: BridgeScope): string {
    const contractId = contract.descriptor.id;
    const readinessVersion = candidateScopeKeys(scope)
      .map((scopeKey) => this._readinessVersionByScope.get(`${contractId}|${scopeKey}`) ?? 0)
      .join(',');
    return `${readinessVersion}:${this.isProvided(contract, { scope }) ? '1' : '0'}`;
  }

  /**
   * Dump current state for diagnostics.
   */
  dump(): {
    bindings: ReturnType<Registry['dump']>;
    mirrors: ReturnType<MirrorRegistry['dump']>;
    nativeReadiness: ReturnType<NativeReadinessMirror['dump']>;
    openStreams: number;
    streamDrops: number;
    counters: ReturnType<typeof diagnostics.getCounters>;
    epoch: number;
  } {
    return {
      bindings: this.registry.dump(),
      mirrors: this._mirrors.dump(),
      nativeReadiness: this.nativeReadiness.dump(),
      openStreams: diagnostics.getOpenStreams(),
      streamDrops: diagnostics.getStreamDrops(),
      counters: diagnostics.getCounters(),
      epoch: this._epoch,
    };
  }
}
