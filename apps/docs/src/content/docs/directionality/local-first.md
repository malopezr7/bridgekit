---
title: Local-first resolution
description: When a JS provider exists in the same runtime, the consumer resolves locally with zero native crossing — enabling web, standalone and test targets.
sidebar:
  order: 3
---

<span class="dir-pill">JS consumes · JS provides · no bridge</span>

If a contract is **provided by JS** and **consumed by JS in the same runtime**, BridgeKit
never touches the native transport. The consumer proxy and `state()` resolve directly
against the in-runtime registry. This is **local-first resolution**.

## Why it exists

It enables pure-JS host providers without any native Kotlin counterpart:

- **Web target** — there is no Kotlin side at all.
- **Standalone / dev mode** — run a feature in isolation with JS-mocked host capabilities.
- **Tests** — feature logic runs in plain Jest with JS providers, no JSI.

## How it works

In `BridgeKitJs.bridge()`, before any transport call, the proxy checks
`registry.resolve(contractId, scope)`. If a JS-local provider exists (same-runtime JS → JS),
calls dispatch directly:

```text
bridge(C).method()  ─┐
                     ├─►  registry.resolve(id, scope)?
                     │        ├─ hit  → invokeLocalAsync / Fire / Sync / openLocalStream
                     │        └─ miss → cross to native transport
```

The four local fast-paths are `invokeLocalAsync`, `invokeLocalFire`, `invokeLocalSync`, and
`openLocalStream`. State reads served from a JS provider come straight from the local mirror.

## The localhost demo

The demo ships a contract that is **never registered in Kotlin**, yet `Sync`, `Async` and
`State` all resolve correctly inside JS:

```ts
// localhost.contract.ts — pure-JS, local-first
export const useLocalhost = defineContract('bridgekit.localhost', {
  methods: {
    getMotto: Sync<string>(),
    greet: Async<{ name: string }, string>(),
  },
  state: {
    mood: State<string>('curious'),
  },
});
```

```ts
// providers.ts
export const localhostImpl = {
  getMotto: () => 'bridge everything, trust nothing',
  greet: ({ name }: { name: string }) => Promise.resolve(`hello, ${name}`),
};
```

```ts
// registerHostProviders.ts — registered once at the JS entry point
const bk = getDefaultBridgeKit();
export const localhostBinding = bk.provide(useLocalhost, localhostImpl);
```

Consuming it looks identical to consuming a native contract — the local-first path is
invisible to the caller:

```tsx
const { getMotto, greet, state } = useLocalhost();
const motto = getMotto();            // resolved in-runtime, no bridge
```

:::tip[Same contract, both modes]
A contract authored for native can be **provided by JS in standalone mode** and **by Kotlin
on device** — the consumer code does not change. The registry decides per-resolution whether
to stay local or cross the bridge.
:::
