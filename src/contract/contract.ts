// ---------------------------------------------------------------------------
// Method / stream / state descriptors + defineContract
// ---------------------------------------------------------------------------

import { validate } from './codec';
import { stableHash } from './hash';
import type { ContractHook, DerivedConsumer, MarkerContractInput } from './markers';
import type { AnySchema, Infer, ObjectSchema } from './schema';
import { t } from './schema';

// ---- method descriptors ---------------------------------------------------

export interface FireDescriptor {
  readonly kind: 'fire';
  readonly params?: ObjectSchema;
}

/** Fire descriptor that carries concrete typed params (preserves field types). */
export interface FireWithParamsDescriptor<P extends ObjectSchema = ObjectSchema>
  extends FireDescriptor {
  readonly params: P;
}

export interface QueryDescriptor {
  readonly kind: 'query';
  readonly params?: ObjectSchema;
  readonly result: AnySchema;
  readonly timeoutMs?: number | null;
}

/** Query descriptor that carries a concrete typed result but no params. */
export interface QueryTypedDescriptor<R extends AnySchema = AnySchema> extends QueryDescriptor {
  readonly result: R;
}

/** Query descriptor that carries concrete typed params and result (preserves field types). */
export interface QueryWithParamsDescriptor<
  P extends ObjectSchema = ObjectSchema,
  R extends AnySchema = AnySchema,
> extends QueryDescriptor {
  readonly params: P;
  readonly result: R;
}

export interface QuerySyncDescriptor {
  readonly kind: 'querySync';
  readonly params?: ObjectSchema;
  readonly result: AnySchema;
}

/** QuerySync descriptor that carries a concrete typed result but no params. */
export interface QuerySyncTypedDescriptor<R extends AnySchema = AnySchema>
  extends QuerySyncDescriptor {
  readonly result: R;
}

/** QuerySync descriptor that carries concrete typed params and result (preserves field types). */
export interface QuerySyncWithParamsDescriptor<
  P extends ObjectSchema = ObjectSchema,
  R extends AnySchema = AnySchema,
> extends QuerySyncDescriptor {
  readonly params: P;
  readonly result: R;
}

// FireWithParamsDescriptor, QueryWithParamsDescriptor, QuerySyncWithParamsDescriptor
// are all structural subtypes of their base interfaces, so they are already included
// in the union via structural subtyping — no need to add them explicitly.
export type MethodDescriptor = FireDescriptor | QueryDescriptor | QuerySyncDescriptor;

// ---- stream descriptor ----------------------------------------------------

export interface StreamDescriptor {
  readonly kind: 'stream';
  readonly value: AnySchema;
  readonly params?: ObjectSchema;
  readonly latestOnly?: boolean;
  readonly sticky?: boolean;
}

/** Stream descriptor with concrete typed value and no params (most common — preserves V through Infer). */
export interface StreamTypedDescriptor<V extends AnySchema = AnySchema> extends StreamDescriptor {
  readonly value: V;
}

/** Stream descriptor with concrete typed value AND params. */
export interface StreamWithParamsDescriptor<
  V extends AnySchema = AnySchema,
  P extends ObjectSchema = ObjectSchema,
> extends StreamDescriptor {
  readonly value: V;
  readonly params: P; // required
}

// ---- state descriptor -----------------------------------------------------

export interface StateDescriptor {
  readonly kind: 'state';
  readonly value: AnySchema;
  readonly initial: unknown;
}

/** State descriptor with concrete typed value (preserves value type through Infer). */
export interface StateTypedDescriptor<V extends AnySchema = AnySchema> extends StateDescriptor {
  readonly value: V;
}

// ---- contract descriptor --------------------------------------------------

export interface ContractDescriptor {
  readonly $type: 'io.github.malopezr7.bridgekit.contract';
  readonly descriptorVersion: 1;
  readonly id: string;
  readonly methods: Record<string, MethodDescriptor>;
  readonly streams: Record<string, StreamDescriptor>;
  readonly state: Record<string, StateDescriptor>;
}

// ---- generated runtime schema artifact (keystone, design Decision 1) -------

/**
 * Resolved schema nodes emitted by the CLI per contract into a `*.bridge.ts`
 * artifact. The app imports it and passes it to
 * `defineContract(id, shape, generatedSchemas)` so the marker descriptor carries
 * the SAME `AnySchema` nodes the CLI hashes — giving hash parity and codec
 * symmetry on the marker path.
 *
 * Shape mirrors the descriptor: per-member `params`/`result`/`value` schemas
 * keyed by member name within `methods` / `streams` / `state`.
 */
export interface GeneratedSchemas {
  readonly methods: Record<string, { readonly params?: AnySchema; readonly result?: AnySchema }>;
  readonly streams: Record<string, { readonly value: AnySchema; readonly params?: AnySchema }>;
  readonly state: Record<string, { readonly value: AnySchema }>;
}

// ---- BridgeStreamSource ---------------------------------------------------

/**
 * Typed stream handle returned by proxy stream accessors.
 * Runtime implementation is provided by Slice B.
 */
export interface BridgeStreamSource<T> {
  subscribe(cb: (v: T) => void): () => void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

// ---- ContractShape (type-level) ------------------------------------------

// MethodShape: maps a MethodDescriptor to its TypeScript call signature.
// Uses named typed sub-interfaces for narrowing to preserve concrete field types
// and avoid TS2589 "Type instantiation is excessively deep" from Infer<AnySchema> evaluation.
// Evaluation order: most specific sub-interface first (WithParams before Typed before base).
type MethodShape<D extends MethodDescriptor> =
  // Fire
  D extends FireWithParamsDescriptor<infer P>
    ? (params: Infer<P>) => void
    : D extends FireDescriptor
      ? () => void
      : // Query (with params)
        D extends QueryWithParamsDescriptor<infer P, infer R>
        ? (
            params: Infer<P>,
            opts?: { timeoutMs?: number | null; signal?: AbortSignal },
          ) => Promise<Infer<R>>
        : // Query (no params, typed result)
          D extends QueryTypedDescriptor<infer R>
          ? (opts?: { timeoutMs?: number | null; signal?: AbortSignal }) => Promise<Infer<R>>
          : // Query (base — fallback, result type unknown)
            D extends QueryDescriptor
            ? (opts?: { timeoutMs?: number | null; signal?: AbortSignal }) => Promise<unknown>
            : // QuerySync (with params)
              D extends QuerySyncWithParamsDescriptor<infer P, infer R>
              ? (params: Infer<P>) => Infer<R>
              : // QuerySync (no params, typed result)
                D extends QuerySyncTypedDescriptor<infer R>
                ? () => Infer<R>
                : // QuerySync (base — fallback)
                  D extends QuerySyncDescriptor
                  ? () => unknown
                  : never;

// StreamShape uses named sub-interfaces to infer concrete V/P, avoiding Infer<AnySchema>
// (which distributes across 12 union branches and causes TS2589 instantiation depth errors).
type StreamShape<D extends StreamDescriptor> =
  D extends StreamWithParamsDescriptor<infer V, infer P>
    ? (params: Infer<P>) => BridgeStreamSource<Infer<V>>
    : D extends StreamTypedDescriptor<infer V>
      ? () => BridgeStreamSource<Infer<V>>
      : () => BridgeStreamSource<unknown>;

// ---- ContractShape, type utilities ----------------------------------------

export type ContractShape<C> = C extends BridgeContract<infer TShape> ? TShape : never;

export type MethodParams<C, M extends string> =
  ContractShape<C> extends { [K in M]: (...args: infer A) => unknown } ? A[0] : never;

export type MethodResult<C, M extends string> =
  ContractShape<C> extends { [K in M]: (...args: unknown[]) => infer R } ? Awaited<R> : never;

export type StreamValue<C, S extends string> =
  ContractShape<C> extends { [K in S]: (...args: unknown[]) => BridgeStreamSource<infer V> }
    ? V
    : never;

export type StateKeys<C> =
  C extends BridgeContract<infer TShape>
    ? TShape extends { state: Record<string, unknown> }
      ? keyof TShape['state']
      : never
    : never;

export type StateValue<C, K extends string> =
  C extends BridgeContract<infer TShape>
    ? TShape extends { state: Record<K, infer V> }
      ? V
      : never
    : never;

// Internal: derive TShape from contract shape definition.
// Uses concrete typed sub-interfaces (WithParams / Typed) to avoid Infer<AnySchema>
// recursion that causes TS2589.
type ContractTShape<
  TMethods extends Record<string, MethodDescriptor>,
  TStreams extends Record<string, StreamDescriptor>,
  TState extends Record<string, StateDescriptor>,
> = {
  [M in keyof TMethods]: MethodShape<TMethods[M]>;
} & {
  [S in keyof TStreams]: StreamShape<TStreams[S]>;
} & {
  state: {
    [K in keyof TState]: TState[K] extends StateTypedDescriptor<infer V> ? Infer<V> : unknown;
  };
};

// ---- BridgeContract -------------------------------------------------------

export interface BridgeContract<TShape> {
  readonly descriptor: ContractDescriptor;
  readonly hash: string;
  readonly _shape?: TShape; // phantom type only, never populated at runtime
}

// ---- defineContract shape -------------------------------------------------

export interface ContractShape_Input {
  methods?: Record<string, MethodDescriptor>;
  streams?: Record<string, StreamDescriptor>;
  state?: Record<string, StateDescriptor>;
}

// ---- Marker descriptor detection ------------------------------------------

/**
 * Returns true when a member descriptor is a marker (has `kind` but no
 * `result`/`value`/`params` schema fields that are AnySchema nodes).
 * Used to branch between the t.* codec path and the schema-less marker path.
 */
export function isMarkerDescriptor(d: Record<string, unknown>): boolean {
  return !('result' in d) && !('value' in d);
}

// ---- Contract ID validation -----------------------------------------------

const CONTRACT_ID_REGEX = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

function validateContractId(id: string): void {
  if (!id) {
    throw new Error('[bridgekit] Contract id must not be empty.');
  }
  if (!CONTRACT_ID_REGEX.test(id)) {
    throw new Error(
      `[bridgekit] Invalid contract id "${id}". ` +
        `Contract ids must be reverse-DNS-ish with at least one dot: e.g. "connect.host", "lia.feature". ` +
        `Pattern: /^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$/`,
    );
  }
}

// ---- defineContract -------------------------------------------------------

/**
 * Define a typed contract.
 *
 * Accepts EITHER:
 *   (a) Legacy t.* shape — returns a BridgeContract (also callable as ContractHook).
 *   (b) Marker shape (Sync/Async/Void/Stream/State markers) — returns a ContractHook
 *       that also satisfies BridgeContract for runtime/codegen compatibility.
 *
 * @param id - Reverse-DNS-ish contract identifier (e.g. "connect.host").
 *   Must match `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/`
 * @param shape - Methods, streams, and state descriptors (t.* or markers).
 * @throws if id is invalid.
 * @throws if any t.* state entry has an initial value that does not match its schema.
 * @throws (via t.union) if any union variant declares its discriminant key.
 */
// Overload A: marker-style input → ContractHook (also BridgeContract-compatible).
export function defineContract<const T extends MarkerContractInput>(
  id: string,
  shape: T,
): ContractHook<T> & BridgeContract<DerivedConsumer<T>>;

// Overload B: t.* style input → BridgeContract (also callable as ContractHook)
export function defineContract<
  TMethods extends Record<string, MethodDescriptor> = Record<never, MethodDescriptor>,
  TStreams extends Record<string, StreamDescriptor> = Record<never, StreamDescriptor>,
  TState extends Record<string, StateDescriptor> = Record<never, StateDescriptor>,
>(
  id: string,
  shape: {
    methods?: TMethods;
    streams?: TStreams;
    state?: TState;
  },
): BridgeContract<ContractTShape<TMethods, TStreams, TState>>;

// Implementation
export function defineContract(
  id: string,
  shape: {
    methods?: Record<string, MethodDescriptor>;
    streams?: Record<string, StreamDescriptor>;
    state?: Record<string, StateDescriptor>;
  },
): BridgeContract<unknown> {
  validateContractId(id);

  const methods = shape.methods ?? {};
  const streams = shape.streams ?? {};
  const state = shape.state ?? {};

  // Validate initial values against their schemas
  for (const [key, stateDescriptor] of Object.entries(state)) {
    const result = validate(stateDescriptor.value, stateDescriptor.initial);
    if (!result.ok) {
      throw new Error(
        `[bridgekit] defineContract("${id}"): state.${key} initial value does not match its schema. ` +
          `${result.message} at path "${result.path}". ` +
          `initial value: ${JSON.stringify(stateDescriptor.initial)}`,
      );
    }
  }

  const descriptor: ContractDescriptor = {
    $type: 'io.github.malopezr7.bridgekit.contract',
    descriptorVersion: 1,
    id,
    methods,
    streams,
    state,
  };

  const hash = stableHash(descriptor);

  const contract: BridgeContract<unknown> = { descriptor, hash };
  return _wrapWithHook(contract);
}

// ---- _wrapWithHook --------------------------------------------------------
// Wraps a BridgeContract with the ContractHook callable interface.
// Lazy: does not import runtime at module eval time.

function _wrapWithHook(contract: BridgeContract<unknown>): BridgeContract<unknown> {
  // Dynamically import buildContractHook to avoid circular at module load time.
  // This is safe because the import is deferred to first call.
  let _cachedHook: ReturnType<typeof import('./contractHook')['buildContractHook']> | null = null;

  const getHook = () => {
    if (_cachedHook) return _cachedHook;
    const { buildContractHook } = require('./contractHook') as typeof import('./contractHook');
    _cachedHook = buildContractHook(contract);
    return _cachedHook;
  };

  // Create a callable that also carries BridgeContract statics
  const hook = ((selector?: (c: unknown) => unknown): unknown => {
    const h = getHook();
    const fn = h as (...args: never[]) => unknown;
    return selector !== undefined ? fn(selector as never) : fn();
  }) as unknown as BridgeContract<unknown>;

  // Copy BridgeContract properties onto the callable
  Object.defineProperty(hook, 'descriptor', {
    get: () => contract.descriptor,
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(hook, 'hash', {
    get: () => contract.hash,
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(hook, '_shape', {
    value: undefined,
    enumerable: false,
    configurable: false,
  });

  // Delegate all ContractHook statics/methods to the lazy hook
  for (const prop of [
    'getState',
    'scoped',
    'useProvide',
    'id',
    '$descriptor',
    '$contract',
  ] as const) {
    Object.defineProperty(hook, prop, {
      get: () => {
        const h = getHook();
        const val = (h as unknown as Record<string, unknown>)[prop];
        if (typeof val === 'function') return val.bind(h);
        return val;
      },
      enumerable: prop === 'id' || prop === '$contract',
      configurable: false,
    });
  }

  // Freeze to satisfy the existing contract that defineContract returns a frozen token.
  // Functions can be frozen; property access still works via getters on the frozen object.
  return Object.freeze(hook);
}

// ---- Descriptor builders (attached to t namespace) ------------------------

// We re-export these as part of the `t` object pattern expected by consumers.
// They are functions, not schema nodes, so they live here (not in schema.ts).

/** Fire-and-forget method: no return value. Failures are counted internally. */
function fire(): FireDescriptor;
function fire<P extends ObjectSchema>(params: P): FireWithParamsDescriptor<P>;
function fire(params?: ObjectSchema): FireDescriptor {
  return params ? { kind: 'fire', params } : { kind: 'fire' };
}

/** Async query. Single-arg overload: result only. Two/three-arg: params + result + opts. */
function query<R extends AnySchema>(result: R): QueryTypedDescriptor<R>;
function query<P extends ObjectSchema, R extends AnySchema>(
  params: P,
  result: R,
  opts?: { timeoutMs?: number | null },
): QueryWithParamsDescriptor<P, R>;
function query(
  paramsOrResult: AnySchema,
  resultArg?: AnySchema,
  opts?: { timeoutMs?: number | null },
): QueryDescriptor {
  if (resultArg === undefined) {
    // single arg = result only
    return { kind: 'query', result: paramsOrResult };
  }
  const descriptor: QueryDescriptor = {
    kind: 'query',
    params: paramsOrResult as ObjectSchema,
    result: resultArg,
  };
  if (opts?.timeoutMs !== undefined) {
    return { ...descriptor, timeoutMs: opts.timeoutMs };
  }
  return descriptor;
}

/** Synchronous query. Only valid for native-provided contracts. */
function querySync<R extends AnySchema>(result: R): QuerySyncTypedDescriptor<R>;
function querySync<P extends ObjectSchema, R extends AnySchema>(
  params: P,
  result: R,
): QuerySyncWithParamsDescriptor<P, R>;
function querySync(paramsOrResult: AnySchema, resultArg?: AnySchema): QuerySyncDescriptor {
  if (resultArg === undefined) {
    return { kind: 'querySync', result: paramsOrResult };
  }
  return { kind: 'querySync', params: paramsOrResult as ObjectSchema, result: resultArg };
}

/** Stream of typed values. Lossless by default (buffered). */
function stream<V extends AnySchema>(
  value: V,
  opts?: { latestOnly?: boolean; sticky?: boolean },
): StreamTypedDescriptor<V>;
function stream<V extends AnySchema, P extends ObjectSchema>(
  value: V,
  opts: { params: P; latestOnly?: boolean; sticky?: boolean },
): StreamWithParamsDescriptor<V, P>;
function stream(
  value: AnySchema,
  opts?: { params?: ObjectSchema; latestOnly?: boolean; sticky?: boolean },
): StreamDescriptor {
  return {
    kind: 'stream',
    value,
    ...(opts?.params !== undefined ? { params: opts.params } : {}),
    ...(opts?.latestOnly !== undefined ? { latestOnly: opts.latestOnly } : {}),
    ...(opts?.sticky !== undefined ? { sticky: opts.sticky } : {}),
  };
}

/**
 * Observable state. Initial value is REQUIRED and must validate against the schema.
 * Validation happens at defineContract time.
 */
function state<V extends AnySchema>(value: V, initial: unknown): StateTypedDescriptor<V> {
  return { kind: 'state', value, initial };
}

// Extend the `t` object with descriptor builders.
// We cast because the base `t` const is `as const` and doesn't include these.
type TWithDescriptors = typeof t & {
  fire: typeof fire;
  query: typeof query;
  querySync: typeof querySync;
  stream: typeof stream;
  state: typeof state;
};

const _tRecord = t as unknown as Record<string, unknown>;
_tRecord.fire = fire;
_tRecord.query = query;
_tRecord.querySync = querySync;
_tRecord.stream = stream;
_tRecord.state = state;

const _t = t as TWithDescriptors;

export { _t as t };
