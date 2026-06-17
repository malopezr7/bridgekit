---
title: What is BridgeKit
description: A typed, bidirectional contract layer between React Native and native code that replaces ad-hoc bridges, event emitters and manual codecs.
sidebar:
  order: 1
---

**BridgeKit** (`@malopezr7/bridgekit`) is a typed, bidirectional communication system between
React Native (JavaScript) and native code. A single TypeScript **contract** is the source
of truth for every crossing of the JS ↔ native boundary. From that one file you get:

- A **typed proxy** on the JS side (`useBridge(Contract)`).
- A **typed interface** to implement on the Kotlin side (generated).
- **Reactive streams** with backpressure, sharing and cancellation.
- **Observable, synchronously-readable state**.
- A **code generator** that keeps both sides in lockstep via a contract hash.

The contract is simultaneously TypeScript types, runtime metadata, and codegen input — so
the types you write are the types you get on both sides, and the wire encoding is derived
from the same schema.

## The problem it solves

In the classic React Native setup, every native ↔ JS crossing is hand-built:

- A Nitro module (or `NativeModule`) defined per surface.
- Hand-written codec logic to marshal arguments and results.
- A **separate** `NativeEventEmitter` registration for anything push-based.
- **No type safety across the boundary** — a typo in an event name or a renamed field is a
  runtime crash, not a compile error.

That boilerplate multiplies per feature, drifts out of sync between platforms, and produces
a recurring class of bugs: `sanitizeParams` crashes on unexpected payloads, dead-callback
emitters after a runtime reload, and render code gated on "is the value ready yet?".

BridgeKit collapses all of that to a single workflow:

```text
define one TypeScript contract  →  run the code generator  →  implement the generated interface
```

The actual JNI crossing is handled by **one fixed, generic transport** compiled inside
BridgeKit (three Nitro hybrid objects). Your feature code never touches a Nitro type, and
Nitrogen runs exactly once — to build that transport — never for feature contracts.

## What makes it different

#### Bidirectional by design

The same four primitives — **async** call, **fire**-and-forget, **stream**, and **state** —
work whether native provides and JS consumes, or JS provides and native consumes. This is
not two systems bolted together; it's one wire protocol used symmetrically.

#### Streams instead of events

A stream is a typed, cancellable, **lossless-by-default** flow of values. It replaces both
the `EventEmitter` pattern (push) and polling (pull). Two QR scans fired back-to-back during
a render commit will not be silently conflated.

#### State you can read synchronously

State is provider-owned and observable, but its initial value is **required** in the
contract. That seeds both the Kotlin store and the JS mirror before any provider binds, so
`get()` is total — it never returns `undefined`, and your render code never has to gate on
readiness.

#### Survives the real lifecycle

The JS runtime dies and is recreated as part of normal production lifecycle (ReactHost
destroy/restart), not just dev reload. BridgeKit models this explicitly as an **epoch** swap:
streams, observers and in-flight calls are tied to an epoch and cleanly rewired on reconnect.

## Where to go next

- New to the ideas? Read **[Core concepts](/start/concepts/)**.
- Ready to build? Jump to the **[Quick start](/start/quickstart/)**.
