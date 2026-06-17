---
title: Scopes, bindings & epochs
description: How a provider is located (scope resolution), how bindings are managed, and how epochs keep cross-bridge resources sane across runtime reloads.
sidebar:
  order: 4
---

Three mechanisms govern *where* a provider lives, *how long* it lives, and *what happens
when the JS runtime restarts*.

## Scopes

A scope answers "which provider serves this call?". It travels in every wire envelope.

| Scope | Meaning |
|---|---|
| `global` | One provider for the whole app. |
| `feature(name)` | Scoped to a feature. |
| `instance(feature, tag)` | Scoped to a specific surface instance — the React root view tag. |

Resolution walks **instance → feature → global**. A feature-specific override transparently
falls back to a global default.

The JS side injects the current feature + instance scope from the BridgeKit context — the React
root view tag is the single source of truth for the instance tag. Proxies resolve scope **at
call time** through the handle/context, so surface recreation replaces the handle and nothing
caches a dead tag.

```tsx
<BridgeScopeProvider feature="connect" instance={rootTag}>
  {children}
</BridgeScopeProvider>
```

On the native side, `BridgeKitScope` is a first-class object. A feature fragment creates one
when its surface starts (keyed by rootTag) and closes it in `onDestroyView` — closing
bindings, cancelling in-flight calls with `CANCELLED`, ending streams, and transitioning
state to `Unprovided`. On iOS, close the binding in `viewDidDisappear(_:)` / `deinit`, or in
SwiftUI via the `.onDisappear` modifier.

## Bindings

A **binding** is a provider registered in a scope. Rules:

- **Exactly one live binding** per `(contract, scope)`.
- A duplicate `provide` on an occupied slot **replaces** with a dev warning.
- `Binding.close()` is **handle-scoped** and a no-op if it was already superseded — this
  kills the register/unregister race.
- Closing a binding closes all its streams on **both** sides.

```kotlin
val binding = bridgekit.provide(ConnectHostContract, scope) { ConnectHostProvider(deps) }
binding.close()
```

Provider factories are **lazy** — resolved on first use, unless `eager = true`.

## Epochs

An **epoch** is one JS-runtime connection generation. The JS runtime dies and is recreated
as part of *normal production lifecycle* (ReactHost destroy/restart), not just dev reload —
so `connectDispatcher` is an **epoch swap**, not a one-time event.

On each connect, the native core allocates a monotonic epoch id and **atomically
supersedes** the previous dispatcher. On supersession (or disconnect detection) it:

- cancels all prior-epoch stream pump jobs and Flow collections;
- fails prior-epoch in-flight native → JS calls with `BRIDGE_NOT_READY`;
- releases all prior-epoch callbacks;
- marks all JS-provided contracts **unprovided** (their mirrors go to `Unprovided`) until
  the new bundle re-registers them.

Durable native-side interests — `consume` subscriptions to JS streams, state observations —
are **re-parked** and replayed against the new dispatcher. The park buffer serves both first
connect and reconnect.

`connectDispatcher` returns a **state snapshot** of all natively-provided state (the
hydration handshake), so `BridgeKitReady` on the JS side implies hydrated mirrors. Readiness
is **not monotonic** — it drops on runtime teardown. Stream and observer ids are
epoch-scoped, so late calls from a dead runtime are rejected cheaply.

:::note[Why this is a headline feature]
Mid-stream runtime reload is part of the on-device acceptance matrix: open a stream → reload
the JS runtime → the provider Flow collection is cancelled, no dead callbacks are pumped, the
new epoch rewires parked native subscriptions, and mirrors re-hydrate. The old
`NativeEventEmitter` world had no answer for this.
:::
