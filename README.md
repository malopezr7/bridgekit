<h1 align="center">BridgeKit</h1>

<p align="center">
  Typed, bidirectional communication between React Native and native code.<br/>
  One TypeScript contract drives JS types, runtime metadata, and generated Kotlin/Swift.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@malopezr7/bridgekit"><img src="https://img.shields.io/npm/v/@malopezr7/bridgekit/beta.svg" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/platforms-android%20%7C%20ios-blue.svg" alt="platforms" />
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="license" />
</p>

---

## What is BridgeKit?

BridgeKit lets you define a **single TypeScript contract** and call across the
React Native ↔ native boundary with full type safety in both directions — methods,
fire-and-forget calls, typed streams, and observable state. The native transport is
built on [Nitro Modules](https://nitro.margelo.com), so calls are JSI-fast with no
bridge serialization overhead.

```ts
const ConnectHost = defineContract('connect.host', {
  methods: { isLoggedIn: Async<boolean>() },
  streams: { otpCodes: Stream<string>() },
  state:   { connectivity: State<{ online: boolean }>({ online: false }) },
});
```

From that one definition you get: typed JS proxies + React hooks, and generated
Kotlin **and** Swift bindings — interfaces, data classes, and codecs.

## Platform support

| Platform | Status | Transport | Automated coverage |
| -------- | ------ | --------- | ------------------ |
| Android  | ✅ | Nitro (Kotlin runtime) | 158 unit tests, 130 executing |
| iOS      | ✅ | Nitro (Swift runtime) | 50 engine tests + SDK typecheck |
| Web      | ✅ | In-memory loopback (tests) | 559 tests |

> **Alpha.** The wire protocol is locked. The public API may still change before `1.0`.
>
> On parity: the two native runtimes implement the same contract model, and the
> known behavioural divergences between them are closed and covered by tests —
> invoke timeouts, state `replacing`/`lastKnown` delivery, seam encoding failures,
> lock contention on sync providers, and Android's main-thread policy.
>
> They are not yet *identical*. iOS has no diagnostics module, 28 Android tests
> remain quarantined behind two known StreamHub races, and the iOS engine's
> locking strategy does not yet compile clean under the Swift 6 language mode.
> These are tracked in `KNOWN_ISSUES.md`; none of them silently corrupt data.
>
> Every number in the table above is produced by CI on each pull request. Before
> `0.1.0-alpha.1`, nothing in CI compiled the iOS runtime at all — so treat any
> parity claim in an earlier `0.0.1-beta.x` release as unverified.

## Packages

| Package | Description |
| ------- | ----------- |
| [`@malopezr7/bridgekit`](packages/core) | The library: contract layer, JS runtime, React hooks, and the native Android/iOS modules. |
| [`@malopezr7/bridgekit-cli`](packages/cli) | Code generation — emits Kotlin & Swift bindings from your TypeScript contracts. |

## Version policy

The first stable major tracks React Native minor compatibility. For example,
`83.x.x` targets RN 0.83. Patch and minor releases inside that major can add
BridgeKit fixes or compatible features without changing the tracked React Native
minor line.

## Install

```sh
pnpm add @malopezr7/bridgekit@beta react-native-nitro-modules
pnpm add -D @malopezr7/bridgekit-cli@beta
cd ios && pod install   # iOS only; Android autolinks
```

See the [core package README](packages/core/README.md) for the full Marker API,
React integration, scoping, testing, and diagnostics.

## Development

This is a [pnpm](https://pnpm.io) workspace.

```sh
pnpm install          # install all workspaces
pnpm -r build         # build every package (builder-bob / tsc)
pnpm -r typecheck     # type-check every package
pnpm -r check         # lint with Biome
```

Example apps live under [`apps/`](apps) (standalone and brownfield integrations) and
consume the library via `workspace:*`.

## License

MIT © [malopezr7](https://github.com/malopezr7)
