// ---------------------------------------------------------------------------
// Marker API — type-first BridgeKit descriptors.
//
// CORE CONSTRAINT: TypeScript generic type arguments are ERASED at runtime.
// Each marker factory returns a MINIMAL runtime object carrying only { kind }
// (plus initial for State, and opts fields). The P / R / V types are PHANTOM
// — they exist only at compile time, declared in a `declare`d phantom field
// that is NEVER populated at runtime.
//
// The internal `kind` strings match the existing descriptor vocabulary so the
// runtime proxy and codegen remain unchanged: 'querySync' | 'query' | 'fire'
// | 'stream' | 'state'.
//
// Codegen (ts-morph, DX-2) must STATIC-PARSE these generic arguments from
// source; it cannot read them at runtime.
// ---------------------------------------------------------------------------

// ---- NoParams sentinel ----------------------------------------------------
// A unique sentinel meaning "no params type argument was supplied".
// Used to resolve the Sync<R> vs Sync<P, R> arity ambiguity.

declare const NoParamsBrand: unique symbol;
export interface NoParams {
  readonly [NoParamsBrand]: true;
}

// ---- Phantom carrier -------------------------------------------------------
// Covariant function box so P/R never collapse to `never` and never need a
// runtime value. `declare` → zero runtime footprint.

type Phantom<T> = (x: never) => T;

// ---- IsNoParams helper -----------------------------------------------------

type IsNoParams<P> = [P] extends [NoParams] ? true : false;

// ===========================================================================
// Marker shapes (phantom-typed). __p / __r / __v are NEVER assigned at
// runtime — declared optional + phantom.
// ===========================================================================

export interface SyncMarker<P, R> {
  readonly kind: 'querySync';
  readonly __p?: Phantom<P>;
  readonly __r?: Phantom<R>;
}

export interface AsyncMarker<P, R> {
  readonly kind: 'query';
  readonly timeoutMs?: number | null;
  readonly __p?: Phantom<P>;
  readonly __r?: Phantom<R>;
}

export interface VoidMarker<P> {
  readonly kind: 'fire';
  readonly __p?: Phantom<P>;
}

export interface StreamMarkerT<V, P> {
  readonly kind: 'stream';
  readonly latestOnly?: boolean;
  readonly sticky?: boolean;
  readonly __v?: Phantom<V>;
  readonly __p?: Phantom<P>;
}

export interface StateMarkerT<V> {
  readonly kind: 'state';
  readonly initial: V; // RUNTIME value — the only non-phantom payload
  readonly __v?: Phantom<V>;
}

export type AnyMarkerT =
  | SyncMarker<unknown, unknown>
  | AsyncMarker<unknown, unknown>
  | VoidMarker<unknown>
  | StreamMarkerT<unknown, unknown>
  | StateMarkerT<unknown>;

// ===========================================================================
// Marker factories — overloaded to resolve 1- vs 2-type-arg arity.
// ===========================================================================

// ---- Sync (querySync) ------------------------------------------------------

/** Synchronous query — result only (no params). */
export function Sync<R>(): SyncMarker<NoParams, R>;
/** Synchronous query — params + result. */
export function Sync<P, R>(): SyncMarker<P, R>;
export function Sync(): SyncMarker<unknown, unknown> {
  return { kind: 'querySync' };
}

// ---- Async (query) ---------------------------------------------------------

/** Async query — result only (no params). */
export function Async<R>(opts?: { timeoutMs?: number | null }): AsyncMarker<NoParams, R>;
/** Async query — params + result. */
export function Async<P, R>(opts?: { timeoutMs?: number | null }): AsyncMarker<P, R>;
export function Async(opts?: { timeoutMs?: number | null }): AsyncMarker<unknown, unknown> {
  const marker = { kind: 'query' } as unknown as Record<string, unknown>;
  if (opts?.timeoutMs !== undefined) {
    marker.timeoutMs = opts.timeoutMs;
  }
  return marker as unknown as AsyncMarker<unknown, unknown>;
}

// ---- Void (fire) ---------------------------------------------------------

/** Fire-and-forget — no params. */
export function Void(): VoidMarker<NoParams>;
/** Fire-and-forget — with params. */
export function Void<P>(): VoidMarker<P>;
export function Void(): VoidMarker<unknown> {
  return { kind: 'fire' };
}

// ---- Stream ----------------------------------------------------------------

/** Stream of values — no params. */
export function Stream<V>(opts?: {
  latestOnly?: boolean;
  sticky?: boolean;
}): StreamMarkerT<V, NoParams>;
/** Stream of values — with params. */
export function Stream<V, P>(opts?: {
  latestOnly?: boolean;
  sticky?: boolean;
}): StreamMarkerT<V, P>;
export function Stream(opts?: {
  latestOnly?: boolean;
  sticky?: boolean;
}): StreamMarkerT<unknown, unknown> {
  const marker = { kind: 'stream' } as unknown as Record<string, unknown>;
  if (opts?.latestOnly !== undefined) marker.latestOnly = opts.latestOnly;
  if (opts?.sticky !== undefined) marker.sticky = opts.sticky;
  return marker as unknown as StreamMarkerT<unknown, unknown>;
}

// ---- State -----------------------------------------------------------------

/** Observable state with a required runtime initial value. */
export function State<V>(initial: V): StateMarkerT<V> {
  return { kind: 'state', initial };
}

// ===========================================================================
// Type derivation helpers — map markers to call signatures.
// ===========================================================================

// Stream handle (subscribable + async iterable)
export interface BridgeStreamSource<T> {
  subscribe(cb: (v: T) => void): () => void;
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

// ---- MethodSig: marker → call signature -----------------------------------

type MethodSig<M> =
  M extends SyncMarker<infer P, infer R>
    ? IsNoParams<P> extends true
      ? () => R
      : (params: P) => R
    : M extends AsyncMarker<infer P, infer R>
      ? IsNoParams<P> extends true
        ? (opts?: CallOpts) => Promise<R>
        : (params: P, opts?: CallOpts) => Promise<R>
      : M extends VoidMarker<infer P>
        ? IsNoParams<P> extends true
          ? () => void
          : (params: P) => void
        : never;

type StreamSig<M> =
  M extends StreamMarkerT<infer V, infer P>
    ? IsNoParams<P> extends true
      ? () => BridgeStreamSource<V>
      : (params: P) => BridgeStreamSource<V>
    : never;

// ---- Input shape to defineContract (marker style) -------------------------

export interface MarkerContractInput {
  methods?: Record<string, AnyMarkerT>;
  streams?: Record<string, StreamMarkerT<unknown, unknown>>;
  state?: Record<string, StateMarkerT<unknown>>;
}

// ---- DerivedConsumer -------------------------------------------------------
// The snapshot returned by useLiaHost() — merges method fns + stream fns +
// state handles, mirroring Zustand's merged state+actions.

export type DerivedConsumer<T extends MarkerContractInput> = (T['methods'] extends Record<
  string,
  AnyMarkerT
>
  ? { [K in keyof T['methods']]: MethodSig<T['methods'][K]> }
  : Record<never, never>) &
  (T['streams'] extends Record<string, StreamMarkerT<unknown, unknown>>
    ? { [K in keyof T['streams']]: StreamSig<T['streams'][K]> }
    : Record<never, never>) &
  (T['state'] extends Record<string, StateMarkerT<unknown>>
    ? {
        state: {
          [K in keyof T['state']]: T['state'][K] extends StateMarkerT<infer V>
            ? StateHandle<V>
            : never;
        };
      }
    : Record<never, never>);

// ---- Runtime contract descriptor (marker-style, no schema) ----------------

export interface MarkerContractDescriptor {
  readonly $type: 'io.github.malopezr7.bridgekit.contract';
  readonly descriptorVersion: 1;
  readonly id: string;
  readonly methods: Record<string, { kind: string; timeoutMs?: number | null }>;
  readonly streams: Record<string, { kind: string; latestOnly?: boolean; sticky?: boolean }>;
  readonly state: Record<string, { kind: string; initial: unknown }>;
}

// ===========================================================================
// ContractHook — Zustand-style callable with statics.
//
// Mirrors Zustand's UseBoundStore pattern:
//   useLiaHost()              → full DerivedConsumer (snapshot)
//   useLiaHost(selector)      → selected slice (subscribes if state key)
//   useLiaHost.getState()     → imperative non-React snapshot
//   useLiaHost.scoped(scope)  → another ContractHook bound to that scope
//   useLiaHost.useProvide(impl) → React provide hook (JS→native direction)
// Statics for codegen:
//   useLiaHost.descriptor     → BridgeContract-compatible descriptor
//   useLiaHost.hash           → stable hash (same as BridgeContract.hash)
//   useLiaHost.id             → contract id string
//   useLiaHost.$contract      → brand 'io.github.malopezr7.bridgekit.contract'
//   useLiaHost.$descriptor    → frozen runtime descriptor (kinds + initials)
// ===========================================================================

// BridgeScope re-export for .scoped() parameter
export interface ScopeArg {
  feature?: string;
  instance?: string;
}

export interface ContractHook<T extends MarkerContractInput> {
  // No-arg: full snapshot
  (): DerivedConsumer<T>;
  // Selector: selected slice
  <U>(selector: (consumer: DerivedConsumer<T>) => U): U;

  /** Imperative (non-React) access — no subscription. Like zustand store.getState(). */
  getState(): DerivedConsumer<T>;

  /** Scope the hook to a feature/instance — returns new ContractHook. */
  scoped(scope: ScopeArg | import('./protocol').BridgeScope): ContractHook<T>;

  /** React provide hook — registers impl as JS provider on mount, unregisters on unmount. */
  useProvide(impl: Partial<DerivedConsumer<T>>): void;

  // Statics for codegen compatibility
  /** Contract id (never used as lookup key). */
  readonly id: string;
  /** Stable hash (same algorithm as BridgeContract.hash). */
  readonly hash: string;
  /** BridgeContract-compatible descriptor (for codegen + load.ts duck-typing). */
  readonly descriptor: MarkerContractDescriptor;
  /** Frozen runtime descriptor (kinds + initials). */
  readonly $descriptor: MarkerContractDescriptor;
  /** Brand. */
  readonly $contract: 'io.github.malopezr7.bridgekit.contract';
}

// ---- Public type utility ---------------------------------------------------

export type ConsumerOf<H> = H extends ContractHook<infer T> ? DerivedConsumer<T> : never;
