# @malopezr7/bridgekit-cli

Code-generation CLI for [BridgeKit](../core). It reads your TypeScript **contract**
files and emits native bindings — Kotlin for Android, Swift for iOS — that match the
runtime wire protocol exactly.

## Requirements

- **Node ≥ 22.6** — the CLI loads `*.contract.ts` files directly using Node's native
  TypeScript support (`--experimental-strip-types`), so no separate build step or
  TS loader is needed for your contracts.

## Install

```sh
pnpm add -D @malopezr7/bridgekit-cli@beta
```

This exposes a `bridgekit` binary.

## Usage

```sh
bridgekit generate [options]
```

Emit native files from contract definitions.

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--contracts <glob>` | `**/*.contract.ts` | Glob for contract files |
| `--out-dir <path>` | `bridgekit/generated` | Output directory |
| `--platform <k\|s>` | `kotlin` | Target platform: `kotlin` or `swift` |
| `--package <pkg>` | derived from contract id | Kotlin package override |
| `--into <path>` | — | Mirror the generated output to a second path |
| `--check` | — | Diff against `out-dir` instead of writing; exits `1` on drift |

### Examples

```sh
# Android (Kotlin) — default platform
bridgekit generate \
  --contracts "src/**/*.contract.ts" \
  --out-dir android/app/src/main/java/com/myapp/bridgekit/generated

# iOS (Swift)
bridgekit generate --platform swift \
  --contracts "src/**/*.contract.ts" \
  --out-dir ios/MyApp/bridgekit/generated

# CI guard — fail if generated output is stale
bridgekit generate --check

# Generate locally and mirror into a host native app
bridgekit generate --into ../MyNativeApp/features/myfeature/bridgekit
```

## How it works

`generate` loads each contract in an isolated Node ESM worker (using native type
stripping), collects the contract descriptors, and runs the platform emitter
(`kotlin` or `swift`). A lockfile records the generated surface so `--check` can
detect drift in CI. The CLI is self-contained — its only runtime dependency is
`chalk`.

The worker sends descriptors over a private, versioned tagged protocol on fd 3.
This CLI-owned process protocol is separate from BridgeKit's schema-dependent
runtime wire codec: the CLI must first transport the schema descriptor before it
can apply that codec. Loader payloads are limited to 1 MiB of UTF-8 JSON and 64
nested value levels. Generation fails with a CLI diagnostic when either limit is
exceeded.

State initials declared with `t.json()` must contain JSON-compatible values.
`Date`, `Uint8Array`, `ArrayBuffer`, and `BigInt` are rejected with their value path
instead of being silently coerced or dropped. Use `t.date()`, `t.binary()`, or
`t.int64()` when those carriers are intended.

## License

MIT © [malopezr7](https://github.com/malopezr7)
