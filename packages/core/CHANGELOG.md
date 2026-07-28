# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

### Changed

### Fixed

## [0.1.0-alpha.1] - 2026-07-27

### Breaking

- **The contract-hash computation changed.** The hash is now a correct FNV-1a-32
  over a wire-identity projection of the contract. The `0.0.1-beta.x`
  implementation used broken 32-bit arithmetic — float overflow corrupted roughly
  half the hash space — and folded local configuration into the hash. Every
  contract hash differs from the value `0.0.1-beta.x` produced.
- **The wire format changed alongside it:**
  - `oneOf` envelopes carry a stable `@t: "<kind>:<hash8hex>"` tag instead of the
    positional `@k` index.
  - `int64` values travel as decimal strings (`bigint` in JS) instead of numbers.
  - `descriptorVersion` was removed from the contract descriptor and the connect
    envelope.
  - `t.array(t.optional(...))` preserves `null` holes instead of shifting later
    elements down.
- **There is no migration path and no compatibility shim.** Payloads produced by a
  `0.0.1-beta.x` peer are not decodable here and surface as contract skew.
  Consumers must regenerate every contract and every `bridgekit.lock` with
  `@malopezr7/bridgekit-cli@0.1.0-alpha.1`, and ship the JS and native halves
  together — a mixed deployment will not interoperate.

### Added

- Unified readiness. `provide` / `unprovide` emit readiness deltas that JS and
  native mirror consistently, with monotonic sequencing across epochs; readiness
  waiters resolve across scope fallback.
- Provider lifecycle. Providers re-register and replay their state after a
  transport reconnect. `CloseReason.Replacing` parks waiters inside a grace window
  with tombstone semantics, while `Final` fails them immediately.
- State mirroring. Native readiness and state deltas are mirrored locally, with
  per-subscriber isolation and aborted hydration on failure.
- Stream delivery modes. The `latestOnly` and `sticky` flags are forwarded to
  providers; the replay cache is scoped, guarded and pruned per provider
  generation.
- Receiver-side contract-hash enforcement in the JS dispatcher. `strictHashCheck`
  defaults to `false` and only observes skew; when enabled, `onInvoke`,
  `onStreamOpen` and JS-observable `onStateWrite` reject with
  `INCOMPATIBLE_CONTRACT`. Calls without a hash skip the check, and readiness
  operations bypass it entirely so the readiness contract is preserved.
- Terminal callbacks for callback-style stream consumption:
  `subscribe(cb, options)` accepts `BridgeStreamSubscribeOptions` with `onError`
  and `onComplete`. The type is exported from the contract entrypoint;
  one-argument `subscribe(cb)` calls remain valid.
- State values crossing the native boundary are now schema-encoded on push and
  schema-decoded plus validated on observe — the treatment methods and streams
  already had.
- React hooks subscribe to the unified readiness signal, so a hook retargets when
  a nearer provider becomes ready.
- Swift `BridgeKitDecodeError` gained `bridgeKitThrow(path:expectedType:actualValue:)`
  and `bridgeKitReportDecodeError`, so generated decoders can raise a typed error
  carrying the wire path, the expected type and the actual runtime type.
- MIT `LICENSE` shipped inside the package.

### Changed

- The `dist/module` ESM output is post-processed to carry explicit relative file
  extensions, and its subpath exports are verified at build time. Before this the
  module build failed to resolve under strict-ESM Node with
  `ERR_MODULE_NOT_FOUND`.
- The contract hash covers wire identity only. `timeoutMs`, `latestOnly`,
  `sticky`, `state.initial` and the runtime `scope` no longer affect hash
  equality, so a local configuration change no longer reads as contract skew.
- The `oneOf` codec reads the tags carried on the schema instead of re-deriving
  them for every encoded value; derivation happens once, at schema construction.
- `defineContract` rejects malformed `oneOf` tag sets at definition time — wrong
  arity, empty strings and duplicates.
- Contract hooks resolve their instance from `BridgeKitContext` instead of always
  reaching for the default instance, so `hook()` and `hook.useProvide` agree under
  a `BridgeKitProvider`.
- Readiness snapshot versions are keyed by scope rather than by contract, so an
  unrelated provide no longer busts a consumer's memo.
- The native entrypoint re-exports the single default-instance accessor instead of
  defining a second one. `initBridgeKitNative()` followed by any hook no longer
  trips the duplicate-install guard on a single install.
- The duplicate-install diagnostic reports the real package version.
- Declared `engines.node >= 22`.
- The npm tarball no longer ships `android/src/test`. `android/src/main` and
  `android/build.gradle.kts` remain present for Gradle consumers.

### Removed

- `descriptorVersion` from the contract descriptor and connect envelope. It was
  dead on every platform — never validated, never read.
- Positional `@k` `oneOf` wire tags, fully replaced by stable `@t` tags.

### Fixed

**Hashing and codec**

- FNV-1a-32 was implemented with `*`, so intermediate values overflowed into
  floats and corrupted the hash. It now uses `Math.imul`-based unsigned 32-bit
  arithmetic with pinned golden vectors, and the fallback UTF-8 encoder handles
  surrogates correctly.
- `oneOf` tag ordering used `localeCompare`, making the hash depend on the device
  locale — the same schema hashed `c6bae064` under `en_US` and `7553b24a` under
  `sv_SE`, producing false skew mismatches per device. Ordering is now by code
  unit.
- The hash projection derived structural `oneOf` tags while the codec used the
  tags carried on the schema, so two peers with different authored tags hashed
  identically and then failed to decode each other. The hash now covers the tags
  the codec actually emits. Schemas built through `t.oneOf()` (derived tags) hash
  byte-identically to before this fix.
- `defineContract` crashed at definition time on `t.state(t.int64(), 0n)`; BigInt
  and Date values are now hashable.
- Prototype-pollution hardening. `__proto__` and nested JSON proto keys are
  neutralized in record encode/decode, on tolerant-decode paths and in
  `sanitizeAny`.
- `oneOf` encode failed silently on a value matching no option and produced an
  envelope the peer could not decode; it now fails fast at the sender.
- Tuple `undefined` holes and `t.array(t.optional(...))` shifted element
  positions; positions are preserved.
- `sanitizeAny` lost Date, Map, Set and `Uint8Array` fidelity and could loop
  forever on cyclic `t.json()` values; a cycle guard now covers cyclic and DAG
  shapes.
- `base64ToUint8Array` threw `RangeError` on padding-only input.
- Non-finite numbers are rejected at validate instead of being encoded.
- Binary and `int64` decode accepted wrong-typed wire values silently — a numeric
  wire value decoded to an empty `Uint8Array`, and `BigInt('')` decoded to `0n`.
  Both now throw.

**Registry and provider lifecycle**

- Reconnect snapshot hydration read a double-wrapped wire shape and dropped the
  snapshot.
- Readiness waiters registered on a fallback scope key were never woken.
- Providers were not replayed after a reconnect, and a superseded provider facade
  could poison `record.stateValues` across the reconnect.
- `closeAll('replacing')` had no real tombstone semantics.
- Stream replay could deliver values captured under a stale provider generation.

**State axis**

- JS-to-native `setState` shipped raw JS values with no schema encode, so
  `bigint`, `Date` and `Uint8Array` crossed the bridge unencoded.
- Native-to-JS observed state was never decoded: `int64` surfaced as a string and
  `date` as a number, violating the `Infer<>` contract that methods honored.
- A decode failure at the state seam exposed the raw wire value as the last-known
  value. The typed last-good value is now retained and `INCOMPATIBLE_CONTRACT` is
  latched instead — including for mirrors hydrated from a snapshot before their
  schema attached.
- Local state delivery notified on the provider's scope key while consumers
  subscribed on their own, so a consumer resolved through scope fallback never
  received `setState`. Candidate scope keys are now walked, matching readiness.
- `provide()` mutated the registry before encoding state initials, so a rejected
  initial left a live binding with no announce and partially pushed keys. All
  initials are encoded before any registry mutation, and a failure aborts
  atomically.
- `announceProvided` / `announceUnprovided` bypassed the `stateWrite` guard and
  discarded failing envelopes, so a failed announcement produced silent readiness
  divergence.

**Streams**

- Native `{ok: false}` error terminals were discarded and delivered to JS as clean
  completion. Async iterators now reject with the typed `BridgeError` and
  `subscribe`'s `onError` fires; the local path behaves identically.
- A throwing subscriber callback escaped into the transport callback, starved the
  remaining subscribers and left pending `next()` calls hanging forever. Callbacks
  are isolated per subscriber and waiters always settle.
- A terminal from a closed transport generation could terminate an active
  resubscription and suppress its values.
- `openStreams` diagnostics were decremented only inside `return()`, so naturally
  completed streams leaked the counter; the lease is now idempotent and closes on
  natural completion.
- Buffered values could still be yielded after `return()`.
- The error terminal now clears the replay ring buffer; clean completion still
  drains it.

**React**

- Readiness subscriptions were unstable across re-renders.

**iOS**

- `Router.isFinalClosed` and `Router.readinessDelta` in the shipped Swift engine
  never compiled — `isFinalClosed` had never compiled at all, and `readinessDelta`
  regressed on 2026-07-04 and stayed broken for 23 days because no CI job builds
  `packages/core/ios`. Both are fixed and the committed `ios-facade` XCFramework
  was regenerated from the repaired sources.

**Runtime environment**

- Dev-mode detection read `process.env` directly from the runtime and misdetected
  the environment; it now defaults to production when no Node environment is
  present.
- Typecheck fixtures are excluded from the package output.

## [0.0.1-beta.2] - 2026-06-25

Corresponds to commit `049177c` — exposes the iOS BridgeKit engine as a
C++-clean, SPM-consumable facade.

Nothing further is recorded. This release predates any changelog discipline in
this repository, and its contents beyond that commit are not reconstructable.

## [0.0.1-beta.1] - 2026-06-23

Published from an uncommitted version state: `packages/core/package.json` read
`83.0.0` at the time, so this release cannot be traced to a repository commit and
its contents cannot be reconstructed. Recorded here only so the published version
history is complete.

## [0.0.1-beta.0] - 2026-06-23

First publish of `@malopezr7/bridgekit` to npm. Published from the same
uncommitted version state as `0.0.1-beta.1` (`packages/core/package.json` read
`83.0.0`), so it likewise cannot be traced to a repository commit. Recorded here
only so the published version history is complete.

Note: the npm `latest` dist-tag still points at this version, not at
`0.0.1-beta.2`. Installing without an explicit version resolves to this build.
