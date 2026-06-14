// ---------------------------------------------------------------------------
// Schema DSL — pure, serializable, zero side effects
// All nodes are plain objects that JSON.stringify cleanly.
// ---------------------------------------------------------------------------

// ---- node kinds -----------------------------------------------------------

export interface StringSchema {
  readonly kind: 'string';
}

export interface NumberSchema {
  readonly kind: 'number';
}

export interface BooleanSchema {
  readonly kind: 'boolean';
}

export interface VoidSchema {
  readonly kind: 'void';
}

export interface JsonSchema {
  readonly kind: 'json';
}

export interface LiteralsSchema<T extends string = string> {
  readonly kind: 'literals';
  readonly values: readonly T[];
}

export interface ObjectSchema<
  TFields extends Record<string, AnySchema> = Record<string, AnySchema>,
> {
  readonly kind: 'object';
  readonly fields: TFields;
}

export interface ArraySchema<TItem extends AnySchema = AnySchema> {
  readonly kind: 'array';
  readonly item: TItem;
}

export interface RecordSchema<TValue extends AnySchema = AnySchema> {
  readonly kind: 'record';
  readonly value: TValue;
}

export interface OptionalSchema<TInner extends AnySchema = AnySchema> {
  readonly kind: 'optional';
  readonly inner: TInner;
}

export interface NullableSchema<TInner extends AnySchema = AnySchema> {
  readonly kind: 'nullable';
  readonly inner: TInner;
}

export interface UnionSchema<
  TKey extends string = string,
  TVariants extends Record<string, ObjectSchema> = Record<string, ObjectSchema>,
> {
  readonly kind: 'union';
  readonly discriminant: TKey;
  readonly variants: TVariants;
}

export interface Int64Schema {
  readonly kind: 'int64';
}

export interface DateSchema {
  readonly kind: 'date';
}

export interface BinarySchema {
  readonly kind: 'binary';
}

export interface EnumSchema<
  TMembers extends readonly { name: string; value: number }[] = readonly {
    name: string;
    value: number;
  }[],
> {
  readonly kind: 'enum';
  readonly members: TMembers;
}

export interface TupleSchema<TItems extends readonly AnySchema[] = readonly AnySchema[]> {
  readonly kind: 'tuple';
  readonly items: TItems;
}

export interface OneOfSchema<TOptions extends readonly AnySchema[] = readonly AnySchema[]> {
  readonly kind: 'oneOf';
  readonly options: TOptions;
}

// ---- union type -----------------------------------------------------------

export type AnySchema =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | VoidSchema
  | JsonSchema
  | LiteralsSchema<string>
  | ObjectSchema
  | ArraySchema
  | RecordSchema
  | OptionalSchema
  | NullableSchema
  | UnionSchema
  | Int64Schema
  | DateSchema
  | BinarySchema
  | EnumSchema
  | TupleSchema
  | OneOfSchema;

// ---- type inference -------------------------------------------------------

type InferObjectFields<TFields extends Record<string, AnySchema>> = {
  [K in keyof TFields]: Infer<TFields[K]>;
};

type InferVariants<TKey extends string, TVariants extends Record<string, ObjectSchema>> = {
  [K in keyof TVariants]: { [D in TKey]: K } & InferObjectFields<TVariants[K]['fields']>;
}[keyof TVariants];

type InferTuple<TItems extends readonly AnySchema[]> = {
  readonly [K in keyof TItems]: TItems[K] extends AnySchema ? Infer<TItems[K]> : never;
};

type InferOneOf<TOptions extends readonly AnySchema[]> = TOptions extends readonly [
  infer H extends AnySchema,
  ...infer Rest extends readonly AnySchema[],
]
  ? Infer<H> | InferOneOf<Rest>
  : never;

type InferEnumMembers<TMembers extends readonly { name: string; value: number }[]> =
  TMembers extends readonly [
    infer H extends { name: string; value: number },
    ...infer Rest extends readonly { name: string; value: number }[],
  ]
    ? H['value'] | InferEnumMembers<Rest>
    : never;

/**
 * Infer the TypeScript type from a schema node.
 *
 * @example
 * const schema = t.object({ name: t.string(), age: t.number() });
 * type User = t.Infer<typeof schema>; // { name: string; age: number }
 */
export type Infer<T extends AnySchema> = T extends StringSchema
  ? string
  : T extends NumberSchema
    ? number
    : T extends BooleanSchema
      ? boolean
      : T extends VoidSchema
        ? undefined
        : T extends JsonSchema
          ? unknown
          : T extends LiteralsSchema<infer V>
            ? V
            : T extends ObjectSchema<infer F>
              ? InferObjectFields<F>
              : T extends ArraySchema<infer I>
                ? Infer<I>[]
                : T extends RecordSchema<infer V>
                  ? Record<string, Infer<V>>
                  : T extends OptionalSchema<infer I>
                    ? Infer<I> | undefined
                    : T extends NullableSchema<infer I>
                      ? Infer<I> | null
                      : T extends UnionSchema<infer K, infer V>
                        ? InferVariants<K, V>
                        : T extends Int64Schema
                          ? bigint
                          : T extends DateSchema
                            ? Date
                            : T extends BinarySchema
                              ? Uint8Array
                              : T extends EnumSchema<infer M>
                                ? InferEnumMembers<M>
                                : T extends TupleSchema<infer I>
                                  ? InferTuple<I>
                                  : T extends OneOfSchema<infer O>
                                    ? InferOneOf<O>
                                    : never;

// ---- DSL builder ----------------------------------------------------------

/**
 * Schema DSL namespace. All methods return plain serializable schema nodes.
 * No classes, no functions stored in nodes.
 */
export const t = {
  /** Primitive string type */
  string: (): StringSchema => ({ kind: 'string' }),

  /** Primitive number type */
  number: (): NumberSchema => ({ kind: 'number' }),

  /** Primitive boolean type */
  boolean: (): BooleanSchema => ({ kind: 'boolean' }),

  /** Void / no-value type (produces undefined at runtime) */
  void: (): VoidSchema => ({ kind: 'void' }),

  /**
   * Untyped escape hatch. TS type is `unknown`.
   * Encoding sanitizes: strips undefined and functions recursively.
   * Validation is always ok (intentional).
   */
  json: (): JsonSchema => ({ kind: 'json' }),

  /** Union of string literal values */
  literals: <T extends string>(...values: [T, ...T[]]): LiteralsSchema<T> => ({
    kind: 'literals',
    values,
  }),

  /** Object with declared fields */
  object: <TFields extends Record<string, AnySchema>>(fields: TFields): ObjectSchema<TFields> => ({
    kind: 'object',
    fields,
  }),

  /** Homogeneous array */
  array: <TItem extends AnySchema>(item: TItem): ArraySchema<TItem> => ({
    kind: 'array',
    item,
  }),

  /** String-keyed record with homogeneous values */
  record: <TValue extends AnySchema>(value: TValue): RecordSchema<TValue> => ({
    kind: 'record',
    value,
  }),

  /** T | undefined */
  optional: <TInner extends AnySchema>(inner: TInner): OptionalSchema<TInner> => ({
    kind: 'optional',
    inner,
  }),

  /** T | null */
  nullable: <TInner extends AnySchema>(inner: TInner): NullableSchema<TInner> => ({
    kind: 'nullable',
    inner,
  }),

  /**
   * Discriminated union.
   *
   * @param discriminant - The key used to discriminate variants (must NOT appear in variant fields).
   * @param variants - Record of variant name → object schema.
   *
   * At the TS level each variant gets the discriminant key injected as a literal string type.
   * In Kotlin codegen this maps to a sealed interface.
   *
   * @throws if any variant declares the discriminant key itself.
   */
  union: <TKey extends string, TVariants extends Record<string, ObjectSchema>>(
    discriminant: TKey,
    variants: TVariants,
  ): UnionSchema<TKey, TVariants> => {
    for (const [variantName, variantSchema] of Object.entries(variants)) {
      if (discriminant in variantSchema.fields) {
        throw new Error(
          `[bridgekit] union discriminant key "${discriminant}" must not be declared in variant "${variantName}" fields. ` +
            `bridgekit injects it automatically — remove it from the variant object.`,
        );
      }
    }
    return { kind: 'union', discriminant, variants };
  },

  /**
   * 64-bit integer. JS carrier: `bigint`. Kotlin: `Long`.
   * Wire: native Int64 (AnyMap.ValueType includes bigint as Int64).
   * Use this when values may exceed 2^53 (Number.MAX_SAFE_INTEGER).
   */
  int64: (): Int64Schema => ({ kind: 'int64' }),

  /**
   * Point-in-time value. JS carrier: `Date`. Kotlin: `java.time.Instant`.
   * Wire: epoch milliseconds as a number (UTC, tz-free).
   */
  date: (): DateSchema => ({ kind: 'date' }),

  /**
   * Raw bytes. JS carrier: `Uint8Array` (also accepts `ArrayBuffer` on input).
   * Kotlin: `ByteArray`. Wire: base64-encoded string.
   */
  binary: (): BinarySchema => ({ kind: 'binary' }),

  /**
   * Numeric enum. JS carrier: the numeric member values (number).
   * Kotlin: Int-backed `enum class` with `wireValue: Int`.
   *
   * @param members - Record of name → numeric value (matches a TS numeric enum).
   *
   * @example
   * t.enum({ Red: 0, Green: 1, Blue: 2 })
   */
  enum: <const TRecord extends Record<string, number>>(
    members: TRecord,
  ): EnumSchema<
    {
      readonly [K in keyof TRecord & string]: { readonly name: K; readonly value: TRecord[K] };
    }[keyof TRecord & string][]
  > => ({
    kind: 'enum',
    members: Object.entries(members).map(([name, value]) => ({ name, value })) as never,
  }),

  /**
   * Fixed-arity positional tuple. JS carrier: readonly tuple. Kotlin: generated data class.
   * Wire: positional JSON array.
   *
   * @example
   * t.tuple([t.string(), t.number()]) // [string, number]
   */
  tuple: <const TItems extends readonly AnySchema[]>(items: TItems): TupleSchema<TItems> => ({
    kind: 'tuple',
    items,
  }),

  /**
   * Primitive / non-discriminated union. Wire: `{ "@k": branchIndex, "@v": value }` envelope.
   * Encoding picks the FIRST branch whose validate passes (first-match-by-validate).
   * When two branches accept the same value, the first match wins — document this at author sites.
   *
   * Distinct from `t.union` (which requires object variants + discriminant key).
   *
   * @example
   * t.oneOf([t.string(), t.number()]) // string | number
   */
  oneOf: <const TOptions extends readonly AnySchema[]>(
    options: TOptions,
  ): OneOfSchema<TOptions> => ({
    kind: 'oneOf',
    options,
  }),
} as const;

// Attach Infer to the t namespace for ergonomic usage: t.Infer<typeof schema>
export declare namespace t {
  export type Infer<T extends AnySchema> = import('./schema').Infer<T>;
}
