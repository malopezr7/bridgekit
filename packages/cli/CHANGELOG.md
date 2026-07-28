# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

### Changed

### Fixed

## [0.1.0-alpha.1] - 2026-07-27

### Breaking

- **Generated code and lock files produced by `0.0.1-beta.0` are not compatible.**
  The contract hash written into `bridgekit.lock` and emitted into generated
  Kotlin and Swift is computed by a different algorithm over a different
  projection — see `@malopezr7/bridgekit` 0.1.0-alpha.1 — and the emitted codecs
  changed wire format: `oneOf` uses stable `@t: "<kind>:<hash8hex>"` tags instead
  of the positional `@k` index, `int64` is emitted and parsed as a decimal string,
  and `descriptorVersion` is gone.
- **There is no migration path and no compatibility shim.** Delete the generated
  output and `bridgekit.lock`, then re-run `bridgekit generate` against
  `@malopezr7/bridgekit@0.1.0-alpha.1`. Regenerate every platform in the same
  pass and ship them together — a peer still running `0.0.1-beta.0` output will be
  rejected as contract skew.
- **Generated filenames can change.** Contracts whose IDs normalize to the same
  base name now emit `<Base>_<hash8(id)>Contract` instead of silently overwriting
  one another. Re-run generation rather than renaming files by hand; a forced
  second-level collision is now a hard error naming both IDs.
- **Generated Swift decoders no longer call `fatalError` and no longer force-cast
  with `as!` / `as?`.** Contract skew previously aborted the iOS process, or — on
  optional results — coerced a type mismatch to `nil` indistinguishable from an
  absent value. Skew now raises `BridgeKitDecodeError`; on `AsyncStream`-shaped
  stream and state surfaces, where the generated API cannot throw, it is reported
  through `bridgeKitReportDecodeError`.
- `engines.node` is now `>=22.15.0`.

### Added

- Real-compiler verification of the emitted bindings. Generated Swift is
  typechecked with `swiftc` against the shipped `BridgeKit` framework and
  generated Kotlin is compiled with Gradle, so emitter regressions fail before
  they reach a consumer.
- Deterministic filename disambiguation on contract-ID collision:
  `<Base>_<hash8(id)>Contract`, stable and order-independent across
  regenerations.
- The contract loader transports rich state initials across its out-of-band
  channel: `bigint`, `Date`, `Uint8Array` and `ArrayBuffer` now survive the
  round-trip. Previously `JSON.stringify` threw on a `bigint` initial — the only
  initial `defineContract` accepts for `t.int64()` state — making `t.int64()`
  state unusable through the CLI entirely.
- Package metadata, a README, and the MIT `LICENSE` shipped in the tarball.

### Changed

- The contract loader communicates its token over a dedicated file descriptor
  (fd 3) rather than stdout, so logging from a contract file can no longer corrupt
  the loader protocol. This protects against accidental interference only:
  hardening against a maliciously authored contract is an explicit non-goal —
  `bridgekit generate` executes contract files as arbitrary code by design, and a
  hostile contract can forge the channel. The non-goal is documented in
  `src/load.ts`.
- The loader payload is bounded: 1 MiB, 64 levels of nesting, 10,000 nodes, with a
  matching spawn buffer. Deeply nested or oversized payloads now fail with a
  `CliError` instead of overflowing the parent decoder or hitting an implicit
  `ENOBUFS`.
- `generate` determines which generated files it owns from the previous
  `bridgekit.lock` rather than by sniffing file contents, so orphan cleanup can
  only delete files it can prove it wrote.
- The hash used for the lock and for emitted bindings comes from a single shared
  implementation in `@malopezr7/bridgekit`; the per-member copies in `lock.ts` and
  `emit/types.ts` are gone.
- Generated codec output no longer carries trailing whitespace on blank lines, so
  regenerated files diff cleanly.

### Fixed

- Swift enum-result boundary decode emitted unbalanced parentheses and an
  unwrapped `Int(exactly:)`, producing code that did not compile or silently
  mis-decoded.
- State-channel values were emitted with no schema-aware codec. Both platforms now
  encode on the provider side and decode on the caller side.
- `t.date()` and `t.binary()` state initials generated corrupt native code.
  The JSON round-trip turned a `Date` into an ISO string and a `Uint8Array` into
  an index map, while the emitters only special-cased `int64`; generation exited
  `0` and native decode threw at runtime. Initials are now emitted in wire form —
  epoch milliseconds for dates, Base64 for binary.
- Epoch literals for `date` initials boxed as Swift `Int` while the decoder
  accepted `Int64` / `Double`, so the initial was unavailable even though the code
  compiled.
- Empty collection initials were untyped: Kotlin `mapOf()` / `listOf()` could not
  infer their type arguments, and an empty Swift object emitted `[]` (array)
  instead of `[:]` (dictionary).
- `-0` was normalized to `+0` in transit, so a signed-zero initial silently became
  positive zero.
- Caller `Params` type names collided with other generated types; they are now
  suffixed through the name allocator.
- Generated identifiers and literals are escaped against the target language:
  Kotlin `$` interpolation, the Kotlin `L` int64 suffix, and Swift `\u{XX}`
  sequences.
- `generate --check` passed on an empty contract glob; it now fails closed, so a
  misconfigured path can no longer report a clean drift check.
- CLI flags given without a value resolved to `''` and were used as if provided;
  they now fail.
- The purity checker missed relative imports spread across multiple lines and
  `require()` calls.
- Non-JSON rich values inside `t.json()` initials — `Date`, `Uint8Array`,
  `bigint` — were silently emitted as maps or `nil`; they are now rejected
  explicitly.
- The generated-Swift compile harness re-declared `BridgeKitDecodeError` and
  `bridgeKitThrow` by hand and had drifted from the runtime, typechecking
  generated code against an API that no longer existed — a gate that could not
  fail. It now inlines the shipped source verbatim.
- The negative Kotlin Gradle gate returned early and reported green when its
  opt-in environment variable was unset, downgrading a compiler proof to a passing
  no-op. It now skips explicitly.
- The committed generated Swift bindings in the example apps had gone stale
  against the emitter; all 15 files were regenerated.

## [0.0.1-beta.0] - 2026-06-23

First and only publish of `@malopezr7/bridgekit-cli` on the `0.0.1-beta` line.

Published from an uncommitted version state: `packages/cli/package.json` read
`0.0.0` on this date, and the string `0.0.1-beta.0` was only written into the repo
on 2026-07-03 (`aeb9678`). This release therefore cannot be traced to a repository
commit and its contents cannot be reconstructed. Recorded here only so the
published version history is complete.

Note: the npm `latest` dist-tag points at this version.
