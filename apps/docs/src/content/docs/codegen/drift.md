---
title: Drift & cross-repo delivery
description: How the contract hash, bridgekit.lock, the --into mirror and the additive-only evolution rule keep independently-deployed bundle and native binaries honest.
sidebar:
  order: 4
---

In a real deployment the JS bundle and the native binaries ship **independently** — the bundle is
often renovate-ignored. **Skew is the steady state**, not an error condition. BridgeKit treats
it as a first-class concern.

## The contract hash

A 32-bit hash over the normalized descriptor is baked into **both** the generated native
binding and the JS descriptor. At bind / first-resolution time the router diffs member sets:

- **Missing members** → one structured warning naming the missing members **and both hashes**.
- **Full hash mismatch on identical member sets** → tolerated (this is additive evolution).
- **Calls to a removed member** → fail with `METHOD_NOT_FOUND` carrying the diff context.

So a newer bundle talking to an older native descriptor degrades **gracefully and loudly**,
never silently.

## `bridgekit.lock`

A generated `contract id → hash` map, committed next to the generated bindings in the consuming
repo. It lets the native repo's CI verify internal consistency **without a Node toolchain** —
no need to run the TypeScript generator on the native CI.

The lock carries a `platform` field recording which emitter produced it:

```jsonc
{
  "platform": "kotlin",       // or "swift"
  "contracts": {
    "example.host": {
      "hash": "8e552bd7",
      "members": {
        "methods.getAppVersion":         "71ff3fa0",
        "methods.getCountryAndLanguage": "27aee930",
        "methods.getLiteral":            "494175a7",
        "methods.openUrl":               "fb545690",
        "methods.trackEvent":            "99cf4370"
      }
    }
  }
}
```

Each platform (Kotlin, Swift) has its own lock file in its own output directory.

## `--into <path>` — tool-owned cross-repo copy

When the contracts live in one repo and the generated bindings must land in another (e.g.
`my-android-app/features/inbox/bridgekit/`), `--into` makes that copy **tool-owned** rather
than a manual `cp`:

```bash
bridgekit generate \
  --contracts 'src/**/*.contract.ts' \
  --out-dir bridgekit/generated \
  --into ../my-android-app/features/inbox/bridgekit
```

The same applies to Swift:

```bash
bridgekit generate \
  --platform swift \
  --out-dir ios/contracts/generated \
  --into ../my-ios-app/inbox/contracts
```

## Evolution rule: additive only

The documented, `--check`-enforced rule:

> **Additive only.** New optional fields, new methods, new streams, new state keys are fine.
> **Removals and renames require a new contract id.**

`--check` compares against the last generated descriptors and fails CI on a non-additive
change. This is what lets two independently-deployed artifacts evolve without a lockstep
release.

## Feature detection at runtime

When you genuinely need to branch on whether a member exists across a skew boundary, use the
readiness/provision APIs rather than catching errors:

- JS: `useBridgeReady(Contract)` / `isProvided(Contract)`
- Kotlin: `isProvided(contract)` / `awaitProvided(contract, timeout)`
- Swift: `BridgeKitRuntime.default.isProvided(Contract())` / `awaitProvided(Contract(), timeoutMs:)`

:::caution[Binary compatibility, separately]
The contract hash governs **contract-level** skew. The native ABI between the BridgeKit
runtime and `react-native-nitro-modules` is governed separately by **exact version pinning**
(C++ ABI):

- **Android**: version pinned in the BridgeKit AAR; enforced by the singleton alignment
  tooling. The generated-code API is frozen per marker version (`BridgeKitGeneratedApiV1`).
- **iOS**: the native ABI between `BridgeKit.xcframework` and `react-native-nitro-modules` is
  pinned the same way. The xcframework ships as a single binary — any Nitro version bump
  requires a rebuild and a new xcframework release.

The lock `platform` field and the `--check --platform swift` CI step catch contract-level drift
for Swift the same way `--check` (default Kotlin) does for Android.
:::
