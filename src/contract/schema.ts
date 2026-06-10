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
  | UnionSchema;

// ---- type inference -------------------------------------------------------

type InferObjectFields<TFields extends Record<string, AnySchema>> = {
  [K in keyof TFields]: Infer<TFields[K]>;
};

type InferVariants<TKey extends string, TVariants extends Record<string, ObjectSchema>> = {
  [K in keyof TVariants]: { [D in TKey]: K } & InferObjectFields<TVariants[K]['fields']>;
}[keyof TVariants];

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
} as const;

// Attach Infer to the t namespace for ergonomic usage: t.Infer<typeof schema>
export declare namespace t {
  export type Infer<T extends AnySchema> = import('./schema').Infer<T>;
}
