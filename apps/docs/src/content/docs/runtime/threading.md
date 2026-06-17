---
title: Threading model
description: Where provider code runs on Android and iOS — Kotlin Dispatchers, Swift Task/async-await, the main-thread guards, cancellation, and the no-runBlocking rule.
sidebar:
  order: 3
---

BridgeKit is opinionated about threads because the predecessors' threading bugs were the
expensive ones (ANRs, dead-callback pumping, crashes on teardown). The rules differ between
Android and iOS because the concurrency primitives differ, but the principle is the same:
**the engine is thread-agnostic; it never dispatches to the main thread on your behalf**.

## Encoding ≠ validation

Two distinct layers, often confused:

- **Encoding** is **always on**, production included. The codec walks *declared fields only*,
  skipping `undefined` and functions — O(declared fields), no JSON round-trip. Raw user
  objects never reach the AnyMap converter, which kills the `sanitizeParams` crash class at
  the root.
- **Validation** (`VALIDATION_FAILED` on type mismatch) is a **dev-only** layer on top.

## Android — Kotlin concurrency

Provider methods run on `Dispatchers.Default`. Providers may switch context freely. There is
**no `runBlocking` anywhere** in BridgeKit.

### The main-thread ANR guard

The host has a documented `runBlocking` habit. A blocking consume + a 10s readiness wait on
the main looper would be a guaranteed ANR. So BridgeKit's blocking wait path **detects the
main looper and fails fast with a loud error naming the contract** — a clear exception instead
of a frozen UI.

```kotlin
// runBlocking around a bridgekit call is documented as forbidden.
// Use the suspending or explicit alternatives instead:
val lia = bridgekit.tryConsume(LiaFeatureContract)     // non-suspending
if (bridgekit.isProvided(LiaFeatureContract)) { /* ... */ }
bridgekit.awaitProvided(LiaFeatureContract, timeout)   // explicit wait
```

Inbound async `invoke()` runs on `CoroutineScope(SupervisorJob() + Dispatchers.Default)`.
Sync `invokeSync` runs on the calling (JS) thread — the provider must not block.
`fire()` runs on a supervised `fireScope` and swallows errors. Stream pumps run on
`engineScope`; state observers are called inline on the triggering thread
(typically `Dispatchers.Default`).

## iOS — Swift concurrency

Provider methods run in whatever context the engine's `Task` starts on. BridgeKit iOS uses
Swift `Task` / `async-await` throughout. There is no `runBlocking` equivalent, and there are
no `@MainActor` annotations inside the engine.

### Router is NOT an actor

`Router` is guarded by an `NSRecursiveLock`, not a Swift `actor`. An actor would serialize
all calls to its executor, which would **deadlock `querySync` specs**: the JS thread calls
into the Nitro C++ seam synchronously, which calls `Router` — an actor hop would park the
call on a task executor that is not the JS thread, causing a deadlock before the sync call
could return.

`NSRecursiveLock` is reentrant on the same thread, allowing sync paths to nest correctly.

### OnceContinuation guards every CheckedContinuation

Swift crashes if a `CheckedContinuation` is resumed more than once. `OnceContinuation`
(`ios/engine/OnceContinuation.swift`) wraps every `CheckedContinuation` used in the engine
(ParkBuffer, OutboundCallerImpl, stream end signals) and ignores any attempt at double-resume.

### invokeSync toward JS-provided contracts is NOT_SUPPORTED

`OutboundCallerImpl.invokeSync` throws `BridgeKitError.NOT_SUPPORTED`. JS cannot be called
synchronously from native on iOS (or Android). If you need a synchronous result, restructure
as a `query` and use `try await client.method()`.

### withBridgeTimeout

Outbound calls are raced against `Task.sleep` via `withBridgeTimeout`
(`OutboundCallerImpl.swift`). This is the Swift equivalent of the Kotlin `withTimeout` wrapper.

### iOS minimum version: 15.1

BridgeKit iOS requires iOS 15.1+. The engine uses the closure-based
`AsyncStream { continuation in … }` initializer (not the `AsyncStream.makeStream()` API
introduced in iOS 16).

```swift
// Consuming an async-provided contract from Swift:
let client: any ConnectHostClient = BridgeKitRuntime.default.consume(ConnectHostContract())
let version = try await client.getAppVersion()

// State — iterate on a background Task, dispatch to main when needed:
Task {
    for await bv in client.connectivity {
        await MainActor.run { self.updateUI(bv) }
    }
}
```

## Readiness timeout vs call timeout (both platforms)

Two separate budgets:

- **Readiness timeout** — how long a call waits for *(dispatcher connected AND contract
  provided)* before giving up. Default 5000ms (10s readiness poll on iOS via 10ms tick in
  `awaitDispatcher`).
- **Call timeout** — how long the provider has to produce a result once it's running.
  30s default on Android (`withTimeout`); `withBridgeTimeout` on iOS.

A JS call into a not-yet-provided contract **waits, bounded** (covering the
Activity/scene-recreation gap) instead of failing instantly. A binding closing with reason
`replacing` holds incoming calls for a short grace window; only a final close yields
`CONTRACT_NOT_PROVIDED`.

## Cancellation

JS proxies accept an `AbortSignal`:

```ts
const controller = new AbortController();
const p = connect.installEsim({ url, iccId }, { signal: controller.signal, timeoutMs: 30_000 });
controller.abort();   // propagates CANCELLED into the provider's coroutine / Task
```

On Android, cancelling the JS caller propagates `CANCELLED` to the provider's Kotlin
coroutine. On iOS, the corresponding `Task` is cancelled. On the native consume side,
cancelling the collecting `Task` triggers the stream close path, which runs the JS producer's
teardown.

## The dispatcher never rejects

The JS dispatcher catches everything and resolves `{ ok: false, … }`; it never throws at the
transport level. The native router wraps every native → JS dispatch in a timeout + try/catch,
mapping dead-runtime throws, never-settling promises, and JS rejections to envelope codes.
The Nitro double-`await()` / double-`Promise` of value-returning JS callbacks is encapsulated
in one router function so feature code never sees it.
