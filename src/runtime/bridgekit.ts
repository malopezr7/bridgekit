// ---------------------------------------------------------------------------
// BridgeKitJs — main JS-side bridge instance.
// Wires transport + dispatcher + registry + mirrors + typed proxy.
// ---------------------------------------------------------------------------

import { decode, encode, sanitizeAny } from '../contract/codec';
import type { BridgeContract, BridgeStreamSource } from '../contract/contract';
import { isMarkerDescriptor } from '../contract/contract';
import type { BridgeScope } from '../contract/protocol';
import { createBridgeError } from '../contract/protocol';
import { nextCorrelationId } from './correlationId';
import { diagnostics } from './diagnostics';
import { Dispatcher } from './dispatcher';
import type { Binding } from './registry';
import { GLOBAL_SCOPE, Registry } from './registry';
import type { StateMirror } from './stateMirror';
import { MirrorRegistry } from './stateMirror';
import type { BridgeTransport } from './transport';

// ---- helpers ---------------------------------------------------------------

function _isDev(): boolean {
  try {
    if (typeof __DEV__ === 'boolean') return __DEV__;
  } catch {
    // ignore ReferenceError
  }
  return process.env.NODE_ENV !== 'production';
}

/**
 * Encode method params for transport.
 * - t.* path: schema-driven encode (field-stripping, coercion).
 * - Marker path (no params schema): universal deep-sanitize to prevent AnyMap crashes.
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
 * Encode stream params for transport.
 * - t.* path: schema-driven encode.
 * - Marker path: universal deep-sanitize.
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

// ---- Ambient scope ---------------------------------------------------------

let _ambientScope: BridgeScope = GLOBAL_SCOPE;

export function setAmbientScope(scope: BridgeScope): void {
  _ambientScope = scope;
}

export function getAmbientScope(): BridgeScope {
  return _ambientScope;
}

// ---- BridgeCallOpts --------------------------------------------------------

export interface BridgeCallOpts {
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

// ---- BridgeKitJs -----------------------------------------------------------

export class BridgeKitJs {
  readonly registry: Registry;
  private readonly _mirrors: MirrorRegistry;
  private readonly _dispatcher: Dispatcher;
  private readonly _contracts = new Map<string, BridgeContract<unknown>>();
  private _epoch = 0;
  private _connected = false;

  constructor(private readonly _transport: BridgeTransport) {
    this.registry = new Registry();
    this._mirrors = new MirrorRegistry();
    this._dispatcher = new Dispatcher(this.registry, this._contracts);
  }

  /**
   * Wire the dispatcher to the transport.
   * Call once on startup (or on reconnect).
   */
  connect(): void {
    this._dispatcher.setTransport(this._transport);
    const result = this._transport.connect(this._dispatcher);
    this._epoch = result.epoch;
    this._connected = true;

    // Hydrate mirrors from snapshot
    for (const entry of result.snapshot) {
      const stub = {
        descriptor: { id: entry.contractId, methods: {}, streams: {}, state: {} },
        hash: '',
      } as unknown as BridgeContract<unknown>;
      this._mirrors.getOrCreate(stub, entry.key, entry.scope, entry.value).hydrate(entry.value);
    }

    // Attach transport to all existing mirrors
    this._mirrors.attachAll(this._transport);
  }

  /**
   * Register a contract + implementation as a JS provider.
   */
  provide<TShape>(
    contract: BridgeContract<TShape>,
    impl: Partial<TShape>,
    opts?: { scope?: BridgeScope },
  ): Binding {
    this._contracts.set(contract.descriptor.id, contract as BridgeContract<unknown>);
    const scope = opts?.scope ?? _ambientScope;
    const binding = this.registry.provide(contract, impl, { scope });

    // Wire setState + close to notify loopback transport of state changes/unprovided
    const transport = this._transport as import('./loopbackTransport').LoopbackTransport;
    if (typeof transport.notifyStateChange === 'function') {
      const wrappedBinding = binding as Binding & { _statePatched: boolean };
      if (!wrappedBinding._statePatched) {
        wrappedBinding._statePatched = true;
        const originalSetState = binding.setState.bind(binding);
        const originalClose = binding.close.bind(binding);

        binding.setState = (key: string, value: unknown) => {
          originalSetState(key, value);
          transport.notifyStateChange(contract.descriptor.id, scope, key, value);
        };

        binding.close = (reason?: 'replacing' | 'final') => {
          originalClose(reason);
          // Signal unprovided to observers for all state keys
          for (const key of Object.keys(contract.descriptor.state)) {
            transport.notifyStateChange(contract.descriptor.id, scope, key, undefined);
          }
        };
      }
    }

    return binding;
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
              const env = {
                op: 'invoke' as const,
                contractId: desc.id,
                member: prop,
                scope,
                payload: _encodePayload(methodDesc, params),
                correlationId: nextCorrelationId(),
                epoch: this._epoch,
              };
              this._transport
                .invoke(env)
                .then((res) => {
                  if (!res.ok) {
                    diagnostics.incrementFiresDropped();
                    if (_isDev()) {
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
              const env = {
                op: 'invokeSync' as const,
                contractId: desc.id,
                member: prop,
                scope,
                payload: _encodePayload(methodDesc, params),
                correlationId: nextCorrelationId(),
                epoch: this._epoch,
              };
              const result = this._transport.invokeSync(env);
              if (!result.ok) {
                throw createBridgeError(result.code, result.message, {
                  contractId: result.contractId,
                  member: result.member,
                  scope: result.scope,
                });
              }
              if ('result' in methodDesc && methodDesc.result) {
                // Guard: a non-void, non-optional result must carry a value.
                // undefined here means the provider encoded nothing — likely a
                // codegen/contract mismatch (e.g. inbound adapter missing encode call).
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
                return decode(schema, result.value);
              }
              // Marker path: no schema — guard by kind (querySync always expects a result)
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
            // For methods with params: (params, callOpts?) → first arg is params, second is opts
            // For methods without params: (callOpts?) → first arg is opts
            // Marker path: no params schema — detect by checking if first arg looks like opts
            let params: unknown;
            let callOpts: BridgeCallOpts | undefined;
            if (methodDesc.params) {
              params = args[0];
              callOpts = args[1] as BridgeCallOpts | undefined;
            } else if (isMarkerDescriptor(methodDesc as unknown as Record<string, unknown>)) {
              // Marker: distinguish params from opts heuristically.
              // Opts only has timeoutMs/signal; if first arg is present and not opts-shaped, it's params.
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

            const env = {
              op: 'invoke' as const,
              contractId: desc.id,
              member: prop,
              scope,
              payload: _encodePayload(methodDesc, params),
              correlationId: nextCorrelationId(),
              epoch: this._epoch,
            };

            const timeoutMs =
              callOpts?.timeoutMs !== undefined
                ? callOpts.timeoutMs
                : 'timeoutMs' in methodDesc
                  ? methodDesc.timeoutMs
                  : undefined;

            let invocation = this._transport.invoke(env);

            if (timeoutMs !== undefined && timeoutMs !== null) {
              invocation = Promise.race([
                invocation,
                new Promise<typeof invocation extends Promise<infer R> ? R : never>((_, reject) =>
                  setTimeout(
                    () =>
                      reject(
                        createBridgeError(
                          'TIMEOUT',
                          `[bridgekit] TIMEOUT: ${desc.id}.${prop} exceeded ${timeoutMs}ms`,
                        ),
                      ),
                    timeoutMs,
                  ),
                ),
              ]);
            }

            if (callOpts?.signal) {
              const signal = callOpts.signal;
              if (signal.aborted) {
                return Promise.reject(
                  createBridgeError(
                    'CANCELLED',
                    '[bridgekit] CANCELLED: AbortSignal already aborted',
                  ),
                );
              }
              invocation = Promise.race([
                invocation,
                new Promise<typeof invocation extends Promise<infer R> ? R : never>((_, reject) => {
                  signal.addEventListener(
                    'abort',
                    () =>
                      reject(
                        createBridgeError(
                          'CANCELLED',
                          '[bridgekit] CANCELLED: AbortSignal aborted',
                        ),
                      ),
                    { once: true },
                  );
                }),
              ]);
            }

            return invocation.then((res) => {
              if (!res.ok) {
                diagnostics.incrementErrors();
                throw createBridgeError(res.code, res.message, {
                  contractId: res.contractId,
                  member: res.member,
                  scope: res.scope,
                });
              }
              if ('result' in methodDesc && methodDesc.result) {
                // Guard: a non-void, non-optional result must carry a value.
                // undefined here means the provider encoded nothing — likely a
                // codegen/contract mismatch (e.g. inbound adapter missing encode call).
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
                return decode(schema, res.value);
              }
              // Marker path: no schema — guard by kind (query expects a result)
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
            const env = {
              op: 'streamOpen' as const,
              contractId: desc.id,
              member: prop,
              scope,
              payload: _encodeStreamPayload(streamDesc, params),
              correlationId: nextCorrelationId(),
              epoch: this._epoch,
            };

            let streamId: string | null = null;
            const subscribers = new Set<(v: unknown) => void>();
            const capturedTransport = this._transport;

            const closeIfNeeded = () => {
              if (streamId !== null) {
                const id = streamId;
                streamId = null;
                capturedTransport.closeStream(id);
              }
            };

            const openIfNeeded = () => {
              if (streamId !== null) return;
              streamId = capturedTransport.openStream(
                env,
                (value) => {
                  // t.* path: decode via schema; marker path: pass-through
                  const decoded = streamDesc.value ? decode(streamDesc.value, value) : value;
                  for (const cb of subscribers) cb(decoded);
                },
                (_end) => {
                  streamId = null;
                  subscribers.clear();
                },
              );
            };

            return {
              subscribe(cb: (v: unknown) => void): () => void {
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
                const queue: unknown[] = [];
                const waiters: Array<(v: IteratorResult<unknown>) => void> = [];
                let closed = false;
                const iterCb = (v: unknown) => {
                  if (waiters.length > 0) {
                    const w = waiters.shift();
                    if (w) w({ value: v, done: false });
                  } else {
                    queue.push(v);
                  }
                };
                subscribers.add(iterCb);
                openIfNeeded();
                return {
                  next(): Promise<IteratorResult<unknown>> {
                    if (queue.length > 0)
                      return Promise.resolve({ value: queue.shift() as unknown, done: false });
                    if (closed) return Promise.resolve({ value: undefined, done: true });
                    return new Promise((resolve) => waiters.push(resolve));
                  },
                  return(): Promise<IteratorResult<unknown>> {
                    closed = true;
                    subscribers.delete(iterCb);
                    if (subscribers.size === 0) closeIfNeeded();
                    for (const w of waiters.splice(0)) w({ value: undefined, done: true });
                    return Promise.resolve({ value: undefined, done: true });
                  },
                };
              },
            };
          };
        }

        return undefined;
      },
    }) as unknown as TShape;
  }

  /**
   * Get a state mirror for a contract key.
   */
  state(
    contract: BridgeContract<unknown>,
    key: string,
    scopeOverride?: BridgeScope,
  ): StateMirror<unknown> {
    this._contracts.set(contract.descriptor.id, contract as BridgeContract<unknown>);
    const stateDesc = contract.descriptor.state[key as string];
    // Use 'initial' in check to distinguish null (valid initial) from missing descriptor
    const initial =
      stateDesc !== undefined && 'initial' in stateDesc ? stateDesc.initial : undefined;
    const scope = scopeOverride ?? _ambientScope;
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
   * Dump current state for diagnostics.
   */
  dump(): {
    bindings: ReturnType<Registry['dump']>;
    mirrors: ReturnType<MirrorRegistry['dump']>;
    openStreams: number;
    counters: ReturnType<typeof diagnostics.getCounters>;
    epoch: number;
  } {
    return {
      bindings: this.registry.dump(),
      mirrors: this._mirrors.dump(),
      openStreams: 0, // transport-level tracking; mirrors via transport
      counters: diagnostics.getCounters(),
      epoch: this._epoch,
    };
  }
}
