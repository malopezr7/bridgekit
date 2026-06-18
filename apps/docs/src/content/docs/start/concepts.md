---
title: Core concepts
description: The vocabulary of BridgeKit — contract, provider, consumer, scope, binding, state, stream, epoch — defined precisely.
sidebar:
  order: 3
---

BridgeKit has a small, precise vocabulary. Learn these eight words and the rest of the docs
read cleanly.

## Contract

A typed surface with a **stable string id** and no implementation. Ids follow a reverse-DNS
shape, `<owner>.<surface>` (e.g. `example.host`, `example.feature`, `bridgekit.demo-host`),
enforced by a regex at definition time. A contract declares three kinds of members:
**methods**, **streams**, and **state**.

A contract is a runtime-introspectable value, not just a type. That single fact buys a lot:
typed mocks for free, codegen by reading the descriptor (no fragile AST parsing for the
schema style), and schema-driven boundary encoding.

## Provider

The **implementation** of a contract. It can live in Kotlin (a host or feature native
module) or in JS (a React Native feature). The rule is strict: **exactly one live binding
per `(contract, scope)`**.

## Consumer

The other end — it resolves a **typed proxy** from the provider. A consumer can be on the
opposite side (native consumes a JS provider) or the **same** side (JS consumes a JS
provider, resolved locally without crossing the bridge).

## Scope

Where a binding lives and how it's resolved:

- `global` — one provider for the whole app.
- `feature(name)` — scoped to a feature.
- `instance(feature, tag)` — scoped to a specific surface instance (the React root view tag).

Resolution walks **instance → feature → global**, so a feature-specific override falls back
to a global default automatically.

## Binding

A provider registered in a scope. It has a **handle**; closing is handle-scoped. Closing a
binding cancels its in-flight calls (`CANCELLED`), ends its streams, and transitions its
state to `Unprovided` on the consuming side.

## State

A **provider-owned** value that is observable and synchronously readable by the other side.
It is single-writer, **enforced by the router** (`NOT_PROVIDER` if the wrong side writes).
Its initial value is required in the contract, which seeds both the Kotlin store and the JS
mirror so reads are total before any provider exists. Availability is part of the value:

```text
BridgeValue<T> = Available(value) | Initial(value) | Unprovided(lastKnown)
```

## Stream

A typed, cancellable, **lossless-by-default** flow of values. It replaces both events and
polling. Backpressure defaults to a bounded buffer (drop-oldest with a logged diagnostic);
`latestOnly: true` switches to conflation for state-like feeds. BridgeKit collects each
provider Flow **once** per `(binding, stream, params)` and multiplexes to all subscribers.

## Epoch

One **JS-runtime connection generation**. The JS runtime dies and is recreated as part of
normal production lifecycle, so connecting the dispatcher is an *epoch swap*, not a one-time
event. Every cross-bridge resource — streams, observers, in-flight calls, held callbacks —
belongs to an epoch and is cleanly cancelled, failed or replayed when the epoch changes.

---

## How they fit together

```text
        defineContract('app.host', { methods, streams, state })
                                │
                 ┌──────────────┴───────────────┐
            PROVIDER                         CONSUMER
       (one per scope)                  (typed proxy)
       Kotlin or JS impl                useBridge(C) / consume(C)
                                │
                          a BINDING in a SCOPE
                                │
                     STATE · STREAMS · METHODS
                                │
                     all tied to an EPOCH
```

With the vocabulary in hand, head to **[Defining a contract](/contracts/defining/)** to see
how methods, streams and state are declared, or the **[Quick start](/start/quickstart/)**
for an end-to-end round trip.
