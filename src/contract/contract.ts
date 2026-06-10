// ---------------------------------------------------------------------------
// Method / stream / state descriptors + defineContract
// ---------------------------------------------------------------------------

import { validate } from './codec';
import { stableHash } from './hash';
import type { AnySchema, Infer, ObjectSchema } from './schema';
import { t } from './schema';

// ---- method descriptors ---------------------------------------------------

export interface FireDescriptor {
  readonly kind: 'fire';
  readonly params?: ObjectSchema;
}

export interface QueryDescriptor {
  readonly kind: 'query';
  readonly params?: ObjectSchema;
  readonly result: AnySchema;
  readonly timeoutMs?: number | null;
}

export interface QuerySyncDescriptor {
  readonly kind: 'querySync';
  readonly params?: ObjectSchema;
  readonly result: AnySchema;
}

export type MethodDescriptor = FireDescriptor | QueryDescriptor | QuerySyncDescriptor;

// ---- stream descriptor ----------------------------------------------------

export interface StreamDescriptor {
  readonly kind: 'stream';
  readonly value: AnySchema;
  readonly params?: ObjectSchema;
  readonly latestOnly?: boolean;
  readonly sticky?: boolean;
}

// ---- state descriptor -----------------------------------------------------

export interface StateDescriptor {
  readonly kind: 'state';
  readonly value: AnySchema;
  readonly initial: unknown;
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

type MethodShape<D extends MethodDescriptor> = D extends FireDescriptor
  ? D['params'] extends ObjectSchema
    ? (params: Infer<D['params']>) => void
    : () => void
  : D extends QueryDescriptor
    ? D['params'] extends ObjectSchema
      ? (
          params: Infer<D['params']>,
          opts?: { timeoutMs?: number | null; signal?: AbortSignal },
        ) => Promise<Infer<D['result']>>
      : (opts?: { timeoutMs?: number | null; signal?: AbortSignal }) => Promise<Infer<D['result']>>
    : D extends QuerySyncDescriptor
      ? D['params'] extends ObjectSchema
        ? (params: Infer<D['params']>) => Infer<D['result']>
        : () => Infer<D['result']>
      : never;

type StreamShape<D extends StreamDescriptor> = D['params'] extends ObjectSchema
  ? (params: Infer<D['params']>) => BridgeStreamSource<Infer<D['value']>>
  : () => BridgeStreamSource<Infer<D['value']>>;

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

// Internal: derive TShape from contract shape definition
type ContractTShape<
  TMethods extends Record<string, MethodDescriptor>,
  TStreams extends Record<string, StreamDescriptor>,
  TState extends Record<string, StateDescriptor>,
> = {
  [M in keyof TMethods]: MethodShape<TMethods[M]>;
} & {
  [S in keyof TStreams]: StreamShape<TStreams[S]>;
} & {
  state: { [K in keyof TState]: Infer<TState[K]['value']> };
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
 * Define a typed contract. Returns a frozen BridgeContract token.
 *
 * @param id - Reverse-DNS-ish contract identifier (e.g. "connect.host").
 *   Must match `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/`
 * @param shape - Methods, streams, and state descriptors.
 * @throws if id is invalid.
 * @throws if any state entry has an initial value that does not match its schema.
 * @throws (via t.union) if any union variant declares its discriminant key.
 */
export function defineContract<
  TMethods extends Record<string, MethodDescriptor>,
  TStreams extends Record<string, StreamDescriptor>,
  TState extends Record<string, StateDescriptor>,
>(
  id: string,
  shape: {
    methods?: TMethods;
    streams?: TStreams;
    state?: TState;
  },
): BridgeContract<ContractTShape<TMethods, TStreams, TState>> {
  validateContractId(id);

  const methods = (shape.methods ?? {}) as Record<string, MethodDescriptor>;
  const streams = (shape.streams ?? {}) as Record<string, StreamDescriptor>;
  const state = (shape.state ?? {}) as Record<string, StateDescriptor>;

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

  const contract: BridgeContract<ContractTShape<TMethods, TStreams, TState>> = Object.freeze({
    descriptor,
    hash,
  });

  return contract;
}

// ---- Descriptor builders (attached to t namespace) ------------------------

// We re-export these as part of the `t` object pattern expected by consumers.
// They are functions, not schema nodes, so they live here (not in schema.ts).

/** Fire-and-forget method: no return value. Failures are counted internally. */
function fire(): FireDescriptor;
function fire(params: ObjectSchema): FireDescriptor;
function fire(params?: ObjectSchema): FireDescriptor {
  return params ? { kind: 'fire', params } : { kind: 'fire' };
}

/** Async query. Single-arg overload: result only. Two/three-arg: params + result + opts. */
function query(result: AnySchema): QueryDescriptor;
function query(
  params: ObjectSchema,
  result: AnySchema,
  opts?: { timeoutMs?: number | null },
): QueryDescriptor;
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
function querySync(result: AnySchema): QuerySyncDescriptor;
function querySync(params: ObjectSchema, result: AnySchema): QuerySyncDescriptor;
function querySync(paramsOrResult: AnySchema, resultArg?: AnySchema): QuerySyncDescriptor {
  if (resultArg === undefined) {
    return { kind: 'querySync', result: paramsOrResult };
  }
  return { kind: 'querySync', params: paramsOrResult as ObjectSchema, result: resultArg };
}

/** Stream of typed values. Lossless by default (buffered). */
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
function state(value: AnySchema, initial: unknown): StateDescriptor {
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
