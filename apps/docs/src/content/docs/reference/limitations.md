---
title: Limitations & non-goals
description: An honest accounting of what BridgeKit is today, what is still deferred, and the transport's hard limits.
sidebar:
  order: 2
---

Read this before you build something that assumes a capability BridgeKit doesn't have yet.
The line between *built*, *deferred*, and *out of scope* matters.

## Built today

Production-validated, bidirectional, and cross-platform — exercised on a real device on **both**
Android (Kotlin) and iOS (Swift):

- The **Kotlin runtime** — registry, router, epoch manager, park buffer, state store,
  ServiceLoader discovery.
- The **Swift runtime** — `Router`, `StateStore`, `StreamHub`, `OutboundCaller`, the Nitro
  C++/Swift seam, and `BridgeKitRuntime.default`. At parity with Android.
- The **TypeScript runtime** — registry, dispatcher, typed proxies, state mirrors, React
  hooks, marker contract hooks.
- The **code generator** for **both** targets — `bridgekit generate --platform kotlin`
  and `--platform swift`, both schema (`t.*`) and marker authoring styles, with hash parity,
  `bridgekit.lock`, drift `--check`, and `--into`.
- **All four markers in both directions**: Async / Void / Stream / State, native→JS and
  JS→native, including JS→native state push.
- **Local-first resolution** for pure-JS providers.
- The generic **Nitro transport** (the single Nitrogen-built component) on both platforms.
- **Shared and feature-owned host contracts** — a globally-provided host contract plus
  contracts owned and provided by a single feature at `Scope.Feature(...)`. See
  [migrating a feature](/guides/migration/).

## Still deferred

Part of the design and the API is shaped to accommodate them, but **not** built today:

| Area | Status |
|---|---|
| **Web transport** | Deferred. `LoopbackTransport` runs pure-JS providers in-process (web / test / standalone), but there is **no** formal web bridge yet. Local-first resolution already enables a pure-JS web target without a native side; a real transport is the remaining work. |
| **Native binary payloads** | `t.binary()` exists in the TS DSL with a base64 codec, but a native binary round-trip is **not validated end-to-end** (no native binary-specific codec; the wire protocol carries no blobs). Treat it as a JS-level, experimental capability. |
| **Gradle-plugin discovery** | Discovery is ServiceLoader-based on Android and explicit registration at app init on iOS; a Gradle plugin remains a non-goal. |

## Incremental adoption

BridgeKit is built to land in an existing app **incrementally**. You can move a feature onto a
BridgeKit contract a few actions at a time and leave the rest on whatever bridge mechanism the
app already uses — the two coexist at runtime, so a migration never has to be a big-bang
rewrite. The [migration guide](/guides/migration/) walks through moving a feature one contract
at a time.

## Explicit non-goals

Stated outright in the design and still true:

- A **web transport** today (see above) and **native binary payloads** (`t.binary()` is
  JS-level / experimental, not a validated native round-trip).
- Full version negotiation — replaced by hash diffing + the additive-only rule.
- Multi-React-instance beyond instance scoping.

## Hard transport limits

These are properties of the wire format, shared by both platforms — not roadmap items:

- **No binary payloads** in AnyMap (no blobs / `ArrayBuffer`; a top-level `ArrayBuffer` param is
  a possible *future* extension). `AnyMap` is **map-only** — scalars and arrays cross wrapped
  as `{ v: <value> }`.
- **No nested functions** in payloads.
- **No sync path native→JS** — `onInvoke` is Promise-returning. `querySync` is
  **native-provided only**; JS cannot be called synchronously from native, and the provider
  side must be an in-memory lookup (dev asserts `< 2ms`).
- **Stream backpressure is `DROP_OLDEST`, capacity 64** — the oldest element is silently
  dropped and counted in `streamDrops`.
- **Readiness timeout is 5000 ms; the re-provide grace window is 1500 ms** — both hardcoded.

## Correctness notes worth knowing

A few state/epoch edge cases to keep in mind:

- A state observer may not receive the **current value on subscription** in every path —
  prefer the snapshot-on-connect hydration and `useBridgeState`'s `status` field.

:::note[How to read this page]
None of the above blocks the core promise — typed bidirectional contracts on Android and iOS,
with streams and state, validated on both. It's here so you size your work against what's
*real today* versus what the design still reserves room for.
:::
