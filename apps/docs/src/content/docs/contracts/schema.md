---
title: The schema DSL
description: The t.* type namespace — primitives, objects, collections, literal unions, discriminated unions, and the json escape hatch.
sidebar:
  order: 2
---

The `t` namespace is the schema language. It is the input to both TypeScript inference and
boundary encoding, and it maps cleanly onto Kotlin and Swift types in generated code. The
surface was derived from a real action inventory (Connect 19 + LiA 9 + globals 7 +
badges/widgets), so it is intentionally small.

## Primitives

| `t.*` | TypeScript | Kotlin | Swift |
|---|---|---|---|
| `t.string()` | `string` | `String` | `String` |
| `t.number()` | `number` | `Double` | `Double` |
| `t.boolean()` | `boolean` | `Boolean` | `Bool` |
| `t.void()` | `void` | `Unit` | `Void` / no return |

## Objects

```ts
t.object({
  url: t.string(),
  iccId: t.string(),
})
```

Generates a Kotlin `data class` and a Swift `struct` (with a memberwise `public init`).
Objects can be hoisted to a `const`, named, and reused — the generator emits one type and
references it everywhere.

## Collections & modifiers

| `t.*` | TypeScript | Kotlin | Swift |
|---|---|---|---|
| `t.array(T)` | `T[]` | `List<T>` | `Array<T>` |
| `t.record(T)` | `Record<string, T>` | `Map<String, T>` | `Dictionary<String, T>` |
| `t.optional(T)` | `T \| undefined` | `T?` | `Optional<T>` |
| `t.nullable(T)` | `T \| null` | `T?` | `Optional<T>` |

## Literal unions

```ts
t.literals('success', 'already-installed', 'cancelled', 'error')
```

A string-literal union. Generates a Kotlin `enum class` and a Swift `enum` (String raw
value). Kotlin literal values are mangled to `UPPER_SNAKE`; Swift cases are lowercamelCase.
Generation **fails loudly** on mangling collisions. To tolerate forward-compatible skew,
generated enums carry an `UNKNOWN(rawValue)` / `unknown(String)` fallback case at decode time.

## Discriminated unions

```ts
t.union('source', {
  picked: t.object({ uri: t.string(), mime: t.string() }),
  failed: t.object({ error: t.string(), source: t.optional(t.string()) }),
})
```

A tagged union keyed by a discriminant field. Generates a Kotlin **sealed class** (one
subtype per variant) and a Swift **enum with associated values**. This is required by real
contracts — e.g. a media picker whose result is `PickedFile | { error, source? }`.

## Extended scalar types

| `t.*` | TypeScript | Kotlin | Swift | Notes |
|---|---|---|---|---|
| `t.int64()` | `bigint` | `Long` | `Int64` | Requires `bigint` at JS level; validates rejects plain `number`. |
| `t.date()` | `Date` | `java.time.Instant` | `Date` | Wire: epoch ms. Decode handles bigint Nitro path. |
| `t.binary()` | `Uint8Array` | `ByteArray` | `Data` | Wire: base64 string. JS-level codec only — native binary round-trip is **not validated end-to-end**; treat as experimental on native. |
| `t.enum(members)` | union of numeric values | `enum class` (wireValue: Int) | `enum` (Int raw value) | Invalid values pass through on decode (skew tolerance). |
| `t.tuple(items)` | readonly tuple | `data class` (v0, v1, …) | positional struct | Positional JSON array on the wire. |
| `t.oneOf(options)` | union of all option types | `sealed class` (Opt0, Opt1, …) | Swift enum with associated values | Wire: `{ "@k": branchIndex, "@v": value }`. Decode throws on malformed envelope. |

## The json escape hatch

```ts
t.json()
```

Explicit untyped payload: `unknown` in TypeScript, `Any?` in Kotlin and Swift.
Encoding **sanitizes** the value but validation is **skipped**. Use it only where a payload
genuinely has no fixed shape — e.g. an analytics `trackEvent` params bag.

## Type utilities

```ts
type Net = t.Infer<typeof connectivitySchema>;

// Derive types from a whole contract:
type Shape  = ContractShape<typeof ConnectHost>;
type Params = MethodParams<typeof ConnectHost, 'installEsim'>;
type Result = MethodResult<typeof ConnectHost, 'installEsim'>;
type Code   = StreamValue<typeof ConnectHost, 'otpCodes'>;
type State  = StateValue<typeof ConnectHost, 'connectivity'>;
```

:::tip[Encoding is always on]
Schema-driven encoding runs in **every** build, production included. The codec walks
*declared fields only*, skipping `undefined` and functions — so raw user objects never reach
the AnyMap converter. Type **validation** (`VALIDATION_FAILED` on mismatch) is a dev-only
layer on top of that. See [Threading model](/runtime/threading/).
:::
