---
title: Roadmap
description: The on-device acceptance matrix that BridgeKit passes today, the Connect pilot that shipped, and the one frontier still open.
sidebar:
  order: 3
---

The roadmap is anchored to a concrete acceptance matrix, not vibes. Every row below is a
scenario a harness app must pass on a real device — and every row **passes today**, validated
on both Android (Kotlin) and iOS (Swift).

## Acceptance matrix — passed

| # | Scenario | Status |
|---|---|---|
| 1 | Native→RN typed query **and** RN→native typed query (bidirectional round trip). | Passed |
| 2 | Stream native→JS (lossless under JS-thread saturation) **and** JS→native (collection + cancellation reaching the JS producer's teardown). | Passed |
| 3 | State: first-render sync read of a global value; observe on both sides; `Unprovided` on close; re-provide reset. | Passed |
| 4 | **Runtime reload mid-stream** — provider stream cancelled, no dead-callback pumping, new epoch rewires parked subscriptions, mirrors re-hydrate. | Passed |
| 5 | **Two simultaneous instances** of one feature — instance-scoped providers isolated; host recreation re-keys cleanly. | Passed |
| 6 | ServiceLoader discovery in a **minified release build** (R8 consumer rules proven, Android). | Passed |
| 7 | Prod-mode payload with `{ a: undefined }` crosses safely (always-on encoding proven). | Passed |
| 8 | Skew simulation — extra member vs older descriptor → single structured warning + `METHOD_NOT_FOUND` with diff context; feature-detection path. | Passed |
| 9 | Kotlin consume from the main thread → fast loud failure, **not** an ANR. | Passed |
| 10 | `dump()` debug screen shows live bindings / streams / state / epoch — on Android and iOS. | Passed |

## Connect / the host app pilot — shipped

The first real-world adoption is done, not planned:

1. **Adoption & freeze.** `feature-actions` / `connectGet*` / `NativeEventEmitterModule` are
   frozen — no new actions or modules.
2. **First pilot.** Connect's OTP polling moved to an `otpCodes` stream (highest value,
   smallest surface).
3. **Feature-owned contract.** Connect owns `connect.host` (17 actions), provided natively at
   `Scope.Feature("YourApp.Feature")`; `getLiteral` / `trackEvent` consume the shared
   `example.host`; five host actions stay on `FeatureActions`. Runtime-proven (`isLoggedIn`
   JS→native returned `true`; `trackEvent` fired end-to-end).
4. **SPM end-state.** The the host app iOS integration is **pure SPM** — no CocoaPods, no C++
   interop in the app target (`@_implementationOnly import BridgeKit`). This is the target
   end-state for all the host app feature integrations.

The full before/after is in [Migrating Connect to BridgeKit](/guides/migration-connect/).

## Platform expansion

| Target | Status |
|---|---|
| **Android** | Done. Kotlin runtime + codegen, validated on-device. |
| **iOS** | Done, at parity with Android. Swift runtime + codegen, runtime-validated with UI parity; the the host app end-state is pure SPM. |
| **Web** | The open frontier. `LoopbackTransport` already runs pure-JS providers in-process; a **formal web transport** is the remaining work. |

:::tip[Where to verify status]
The code and the contract are the authority on what's landed. This page reflects current
state; check the package and the changelog before depending on anything described as future.
:::
