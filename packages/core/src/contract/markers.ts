// ---------------------------------------------------------------------------
// Schema-first Marker API — W3 rewrite (design D1).
//
// Markers now accept t.* schema VALUES instead of phantom generic type args.
// The runtime descriptor carries the schema nodes directly, so no ts-morph,
// no .bridge.ts, and no third-argument re-injection are required.
//
// Arity is resolved at runtime via `isSchema()` (an object with a `kind`
// string field), not a NoParams sentinel.
//
// The produced descriptors are structurally identical to the t.* descriptor
// forms already in contract.ts, so `_detectMarkerStyle` returns false and
// defineContract takes the standard t.* path — giving hash parity by
// construction.
// ---------------------------------------------------------------------------

import type {
  FireDescriptor,
  FireWithParamsDescriptor,
  QueryDescriptor,
  QuerySyncDescriptor,
  QuerySyncTypedDescriptor,
  QuerySyncWithParamsDescriptor,
  QueryTypedDescriptor,
  QueryWithParamsDescriptor,
  StateDescriptor,
  StateTypedDescriptor,
  StreamDescriptor,
  StreamTypedDescriptor,
  StreamWithParamsDescriptor,
} from './contract';
import type { BridgeStreamSubscribeOptions } from './protocol';
import type { AnySchema, Infer, ObjectSchema } from './schema';

// ---- isSchema discriminator -----------------------------------------------
// An object with a `kind` string field is a schema node.
// Opts objects (AsyncOpts, StreamOpts) deliberately have no `kind`.

function isSchema(x: unknown): x is AnySchema {
  return (
    x != null && typeof x === 'object' && typeof (x as Record<string, unknown>).kind === 'string'
  );
}

// ---- Opts types ------------------------------------------------------------

export interface AsyncOpts {
  timeoutMs?: number | null;
}

export interface StreamOpts {
  latestOnly?: boolean;
  sticky?: boolean;
}

// ---- Sync (querySync) ------------------------------------------------------

/** Synchronous query — result only (no params). */
export function Sync<R extends AnySchema>(result: R): QuerySyncTypedDescriptor<R>;
/** Synchronous query — params + result. */
export function Sync<P extends ObjectSchema, R extends AnySchema>(
  params: P,
  result: R,
): QuerySyncWithParamsDescriptor<P, R>;
export function Sync(a: AnySchema, b?: AnySchema): QuerySyncDescriptor {
  return b === undefined
    ? { kind: 'querySync', result: a }
    : { kind: 'querySync', params: a as ObjectSchema, result: b };
}

// ---- Async (query) ---------------------------------------------------------

/** Async query — result only (no params). */
export function Async<R extends AnySchema>(result: R, opts?: AsyncOpts): QueryTypedDescriptor<R>;
/** Async query — params + result. */
export function Async<P extends ObjectSchema, R extends AnySchema>(
  params: P,
  result: R,
  opts?: AsyncOpts,
): QueryWithParamsDescriptor<P, R>;
export function Async(a: AnySchema, b?: AnySchema | AsyncOpts, c?: AsyncOpts): QueryDescriptor {
  const hasParams = isSchema(b);
  const result = hasParams ? (b as AnySchema) : a;
  const params = hasParams ? a : undefined;
  const opts = hasParams ? c : (b as AsyncOpts | undefined);

  const descriptor: Record<string, unknown> = {
    kind: 'query',
    result,
    ...(params !== undefined ? { params } : {}),
  };
  if (opts?.timeoutMs !== undefined) {
    descriptor.timeoutMs = opts.timeoutMs;
  }
  return descriptor as unknown as QueryDescriptor;
}

// ---- Void (fire) -----------------------------------------------------------

/** Fire-and-forget — no params. */
export function Void(): FireDescriptor;
/** Fire-and-forget — with params. */
export function Void<P extends ObjectSchema>(params: P): FireWithParamsDescriptor<P>;
export function Void(params?: ObjectSchema): FireDescriptor {
  return params === undefined ? { kind: 'fire' } : { kind: 'fire', params };
}

// ---- Stream ----------------------------------------------------------------

/** Stream of values — value schema only, no params. */
export function Stream<V extends AnySchema>(value: V, opts?: StreamOpts): StreamTypedDescriptor<V>;
/** Stream of values — value schema + params. */
export function Stream<V extends AnySchema, P extends ObjectSchema>(
  value: V,
  params: P,
  opts?: StreamOpts,
): StreamWithParamsDescriptor<V, P>;
export function Stream(
  a: AnySchema,
  b?: ObjectSchema | StreamOpts,
  c?: StreamOpts,
): StreamDescriptor {
  const hasParams = isSchema(b);
  const opts = hasParams ? c : (b as StreamOpts | undefined);

  const descriptor: Record<string, unknown> = {
    kind: 'stream',
    value: a,
    ...(hasParams ? { params: b as ObjectSchema } : {}),
  };
  if (opts?.latestOnly !== undefined) descriptor.latestOnly = opts.latestOnly;
  if (opts?.sticky !== undefined) descriptor.sticky = opts.sticky;
  return descriptor as unknown as StreamDescriptor;
}

// ---- State -----------------------------------------------------------------

/** Observable state — value schema required, initial value must match the schema at runtime. */
export function State<V extends AnySchema>(value: V, initial: unknown): StateTypedDescriptor<V>;
export function State(value: AnySchema, initial: unknown): StateDescriptor {
  return { kind: 'state', value, initial };
}

// ===========================================================================
// Type derivation helpers — map descriptors to call signatures.
// ===========================================================================

// Stream handle (subscribable + async iterable)
export interface BridgeStreamSource<T> {
  /**
   * Terminal callbacks may run synchronously. Errors discard buffered values, and a
   * settled handle stays latched; call the stream accessor again for a fresh session.
   */
  subscribe(cb: (v: T) => void, options?: BridgeStreamSubscribeOptions): () => void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

// State handle (Zustand-ish slice)
export interface StateHandle<V> {
  get(): V;
  subscribe(cb: (v: V) => void): () => void;
}

export interface CallOpts {
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

// ---- MethodSig: descriptor → call signature --------------------------------
// Reads Infer<> off descriptor interfaces — no NoParams, no Phantom<T>.
// Order: most-specific (WithParams) first, then result-only, then never.

export type MethodSig<M> =
  M extends QuerySyncWithParamsDescriptor<infer P, infer R>
    ? (p: Infer<P>) => Infer<R>
    : M extends QuerySyncTypedDescriptor<infer R>
      ? () => Infer<R>
      : M extends QueryWithParamsDescriptor<infer P, infer R>
        ? (p: Infer<P>, o?: CallOpts) => Promise<Infer<R>>
        : M extends QueryTypedDescriptor<infer R>
          ? (o?: CallOpts) => Promise<Infer<R>>
          : M extends FireWithParamsDescriptor<infer P>
            ? (p: Infer<P>) => void
            : M extends FireDescriptor
              ? () => void
              : never;

type StreamSig<M> =
  M extends StreamWithParamsDescriptor<infer V, infer P>
    ? (params: Infer<P>) => BridgeStreamSource<Infer<V>>
    : M extends StreamTypedDescriptor<infer V>
      ? () => BridgeStreamSource<Infer<V>>
      : never;

// ---- Input shape to defineContract (descriptor style) ----------------------

export interface MarkerContractInput {
  methods?: Record<string, MethodDescriptorLike>;
  streams?: Record<string, StreamDescriptorLike>;
  state?: Record<string, StateDescriptorLike>;
}

type MethodDescriptorLike = FireDescriptor | QueryDescriptor | QuerySyncDescriptor;
type StreamDescriptorLike = StreamDescriptor;
type StateDescriptorLike = StateDescriptor;

// ---- DerivedConsumer -------------------------------------------------------
// Merges method fns + stream fns + state handles.

export type DerivedConsumer<T extends MarkerContractInput> = (T['methods'] extends Record<
  string,
  MethodDescriptorLike
>
  ? { [K in keyof T['methods']]: MethodSig<T['methods'][K]> }
  : Record<never, never>) &
  (T['streams'] extends Record<string, StreamDescriptorLike>
    ? { [K in keyof T['streams']]: StreamSig<T['streams'][K]> }
    : Record<never, never>) &
  (T['state'] extends Record<string, StateDescriptorLike>
    ? {
        state: {
          [K in keyof T['state']]: T['state'][K] extends StateTypedDescriptor<infer V>
            ? StateHandle<Infer<V>>
            : StateHandle<unknown>;
        };
      }
    : Record<never, never>);

// ---- ScopeArg for .scoped() ------------------------------------------------

export interface ScopeArg {
  feature?: string;
  instance?: string;
}

// ---- ContractHook ----------------------------------------------------------
// Callable hook + statics for codegen compatibility.

export interface ContractHook<T extends MarkerContractInput> {
  (): DerivedConsumer<T>;
  <U>(selector: (consumer: DerivedConsumer<T>) => U): U;

  getState(): DerivedConsumer<T>;
  scoped(scope: ScopeArg | import('./protocol').BridgeScope): ContractHook<T>;
  useProvide(impl: Partial<DerivedConsumer<T>>): void;

  readonly id: string;
  readonly hash: string;
  readonly descriptor: import('./contract').ContractDescriptor;
  readonly $descriptor: import('./contract').ContractDescriptor;
  readonly $contract: 'com.bridgekit.contract';
}

// ---- Public type utility ---------------------------------------------------

export type ConsumerOf<H> = H extends ContractHook<infer T> ? DerivedConsumer<T> : never;
