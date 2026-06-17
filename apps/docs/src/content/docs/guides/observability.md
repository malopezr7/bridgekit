---
title: Observability & debugging
description: Correlation ids, structured traces on both JS console and logcat, BridgeKit.dump(), and the live debug screen.
sidebar:
  order: 3
---

Observability is built in — and the single-choke-point architecture makes it cheap. Every
operation funnels through one place, so tracing and introspection come almost for free.

## Correlation ids & structured traces

Every op carries a `correlationId`. In dev mode, BridgeKit emits a structured trace event for
each op in **one shared format** to the **JS console** and to the native log (logcat on
Android, `os_log` on iOS, both under the `BridgeKit` tag):

```text
op · contract · member · scope · duration · code · origin-side · epoch
```

Because the JS and native traces share a format and a correlation id, you can follow a single
call across the boundary end to end.

## `dump()`

Available on **every** side — JS, Android, and iOS. It prints a live snapshot of everything
the runtime is holding:

- bindings per scope,
- park-buffer contents,
- open streams (and their buffer fill),
- state mirror values,
- the current epoch,
- readiness,
- the cumulative counters: `calls`, `errors`, `firesDropped`, `openStreams`, `streamDrops`.

```ts
// JS
BridgeKit.dump();
```

```kotlin
// Kotlin
BridgeKit.default.dump()
```

```swift
// Swift
BridgeKitRuntime.default.dump()
```

## Errors always state *why*

Every error envelope embeds readiness and provision context, so a failure reads as a
diagnosis rather than a riddle:

```text
TIMEOUT: dispatcher connected, contract 'checkout.host' not provided in scope feature(checkout)
```

## Fire-and-forget is not invisible

Fire-and-forget failures (no provider, no method) are **counted** and surfaced in `dump()`.
A dropped `fire` in production is a number you can see, not a silent void.

## The live debug screen

The harness app ships a debug screen that renders `dump()` **live**, on Android and on iOS.
You watch bindings appear, streams fill, state mirrors update, and the epoch tick over on a
runtime reload, in real time — the same screen, the same snapshot, on both platforms.

:::tip
When a contract "isn't working", reach for `dump()` first. It almost always answers the only
two questions that matter: *is the binding present in the scope I'm resolving?* and *is the
dispatcher connected for the current epoch?*
:::
