---
title: API cheat sheet
description: Every contract primitive, JS hook, and Kotlin entry point on one page.
sidebar:
  order: 1
---

One-page recall. Follow the links for detail.

## Contract primitives

| Marker | Schema DSL | Kind | Direction |
|---|---|---|---|
| `Sync<P, R>()` | `t.querySync(params, result)` | sync read | native-provided only |
| `Async<P, R>()` | `t.query(params, result, opts?)` | async call | either |
| `Void<P>()` | `t.fire(params?)` | fire-and-forget | either |
| `Stream<V, P>()` | `t.stream(value, opts?)` | stream | either |
| `State<V>(initial)` | `t.state(value, initial)` | state | either |

```ts
import { defineContract, t } from '@malopezr7/bridgekit/contract';
// or markers:
import { Async, Void, Stream, State, Sync, defineContract } from '@malopezr7/bridgekit/contract';
```

## Schema types (`t.*`)

```text
t.string()  t.number()  t.boolean()  t.void()  t.json()
t.literals('a', 'b')          → Kotlin enum class / Swift enum (String wire)
t.object({ ... })             → Kotlin data class / Swift struct
t.array(T)  t.record(T)
t.optional(T)  t.nullable(T)
t.union('tag', { a: ..., b: ... })  → Kotlin sealed class / Swift enum
t.int64()                     → Long / Int64
t.date()                      → java.time.Instant / Date   (epoch ms on the wire)
t.binary()                    → ByteArray / Data   (base64 on the wire — JS-level, experimental)
t.enum({ ... })               → enum class (Int wire)
t.tuple([A, B])               → data class (v0, v1) / struct
t.oneOf([A, B])               → sealed class (Opt0, Opt1) / enum
```

`t.binary()` exists in the TS DSL with a pure-JS base64 codec, but a native binary round-trip
is **not validated end-to-end** — treat it as experimental, not a proven capability.

## Stream options

```ts
t.stream(T, { params: t.object({ ... }), latestOnly: true, sticky: true })
```

## JS API

| Symbol | Purpose |
|---|---|
| `useBridge(C, opts?)` | typed proxy (React) |
| `useBridgeState(C, key)` | `{ value, status }` |
| `useBridgeReady(C)` | reactive readiness gate |
| `useProvideBridge(C, impl)` | provide from JS, auto-unregister |
| `getDefaultBridgeKit()` | the singleton instance |
| `bk.bridge(C, opts?)` / `bk.provide(C, impl, opts?)` | imperative forms, off the singleton |
| `binding.close(reason?)` / `binding.setState(key, v)` | handle returned by `bk.provide` |
| `streamSource((emit, end) => teardown)` | JS-provided stream source |
| `isBridgeError(e, code?)` | duck-typed error check |
| `BridgeScopeProvider` | ambient feature/instance scope |
| Marker hook: `C()`, `C(sel)`, `C.getState()`, `C.scoped(s)`, `C.useProvide(impl)` | Zustand-style |

## Kotlin API

| Symbol | Purpose |
|---|---|
| `BridgeKit.default` | shared instance |
| `provide(Contract, scope?) { impl }` | register a lazy provider |
| `consume(Contract)` | typed proxy (suspend, readiness-bounded) |
| `tryConsume(C)` / `isProvided(C)` / `awaitProvided(C, t)` | non-suspending alternatives |
| `binding.close(reason?)` | handle-scoped close (defaults to `CloseReason.Final`) |
| `BridgeKit.default.initialize(host)` | ServiceLoader discovery |
| `BridgeKit.default.dump()` | live snapshot |
| `BridgeValue<T>` | `Available` / `Initial` / `Replacing` / `Unprovided` |
| `OutboundCaller` | the frozen native→JS engine interface |

## Swift API

| Symbol | Purpose |
|---|---|
| `BridgeKitRuntime.default` | shared instance (installs itself as the native delegate) |
| `provide(Contract(), scope:) { impl }` | register a provider; returns a `Binding` |
| `consume(Contract(), scope:)` | typed consumer proxy (native→JS) |
| `isProvided(C())` / `awaitProvided(C(), timeoutMs:)` | readiness checks |
| `binding.close(reason:)` / `binding.close()` | de-register the provider |
| `BridgeValue<T>` | `.available` / `.initial` / `.replacing` / `.unprovided` |
| `AsyncStream<T>` | stream values and native-owned state getters |
| `BridgeKitRuntime.default.dump()` | live snapshot |

Import surface: `import BridgeKit`. The generated Swift files declare the contract objects,
provider protocols and structs directly in your app target — there is no separate generated
module to import. Default scope is `.global`; also `.feature(name)` and
`.instance(feature:tag:)`. See [Swift: provide & consume](/usage/swift/).

## CLI

```bash
bridgekit generate \
  --contracts 'src/**/*.contract.ts' \
  --out-dir bridgekit/generated \
  --platform kotlin \                # or: --platform swift
  [--package <pkg>] [--check] [--into <sibling-path>]
```

`--platform` is `kotlin` (default) or `swift`. Run it once per target; the lock and `--check`
drift are tracked per platform.

## Error codes

```text
CONTRACT_NOT_PROVIDED  METHOD_NOT_FOUND  INCOMPATIBLE_CONTRACT  NOT_PROVIDER
TIMEOUT  CANCELLED  PROVIDER_ERROR  VALIDATION_FAILED  BRIDGE_NOT_READY
```
