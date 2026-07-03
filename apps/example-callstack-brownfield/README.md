# bridgekit-example-callstack-brownfield

BridgeKit embedded into an **existing native app via `@callstack/react-native-brownfield`** —
React Native is packaged into a self-contained native artifact and the host app imports it
**without any Node.js toolchain**.

A bare React Native project is compiled into an **XCFramework** (iOS) / **AAR** (Android) by the
Callstack brownfield CLI. An existing native iOS (Swift) and Android (Kotlin/Compose) app imports
that artifact and presents a React Native screen — using **BridgeKit** (Nitro) — from a native
home screen. Same demo surface as `apps/example`.

## How this differs from the Expo example

| | Expo (integrated) | Callstack (this) |
|---|---|---|
| Node in the host app | yes (native project has `node_modules`) | **no** — host imports a prebuilt artifact |
| Packaging | autolinking at host build time | `brownfield package:*` → XCFramework / AAR |
| Nitro linking | autolinked into the host build | autolinked **into the artifact** (`autolinkLibrariesWithApp` / `inherit! :complete`) |
| Best for | one team iterating both sides | a large native app / team without JS tooling |

Both demonstrate the same BridgeKit integration; they show two complementary brownfield philosophies.

## Stack

| | |
|---|---|
| @callstack/react-native-brownfield | 3.12.0 |
| brownfield-gradle-plugin | 1.1.0 (stable) |
| React Native | 0.83.6 · React 19.2.0 |
| Nitro | react-native-nitro-modules 0.35.0 |
| Architecture | New Architecture + Hermes |

## Layout

```
index.js                  AppRegistry.registerComponent("BridgeKitCallstackBrownfield", App)
src/                      shared demo UI + contracts (cloned from apps/example)
metro/babel               bare RN toolchain (@react-native/metro-config, @react-native/babel-preset)
ios/
  ReactNativeFramework/    the packaged RN framework target (+ Generated/, bridgekit initializer)
  HostApp/                 existing native app; imports the xcframeworks, presents RN
  Podfile, project.yml, README.md
android/
  reactnativeapp/          RN library module (brownfield-gradle-plugin) → AAR to mavenLocal
    ReactNativeHostManager.kt   loadReactNative → BridgeKit init → ReactNativeBrownfield.initialize
    bridgekit/, generated/
  host/                    existing native app; depends on the AAR, presents ReactNativeFragment
  README.md
```

## Brownfield wiring — the bits that matter

- **iOS**: the RN code lives in a Framework target (`use_frameworks! :linkage => :static`,
  `inherit! :complete`). `BridgekitDemoInitializer.configure()` is `public` in the framework and the
  host's `AppDelegate` calls it before `ReactNativeBrownfield.shared.startReactNative(...)`. The host
  presents `ReactNativeViewController(moduleName: "BridgeKitCallstackBrownfield")`.
- **Android**: `ReactNativeHostManager` runs `loadReactNative(application)` →
  `BridgekitDemoInitializer.init(...)` → `PackageList(application).packages.apply { add(BridgeKitPackage()) }`
  → `ReactNativeBrownfield.initialize(application, packages)`. The host presents
  `ReactNativeFragment.createReactNativeFragment("BridgeKitCallstackBrownfield")`.
- **BridgeKit (Nitro)** autolinks into the artifact via the Callstack pipeline — no manual C++
  registration. The only manual step is `add(BridgeKitPackage())` (Nitro is not in `PackageList`).

## Build & run

> Not executed in this repo ("never build" policy). The Callstack flow has an explicit packaging step:

```bash
pnpm install

# iOS: package the framework, then build the host against the xcframeworks
cd apps/example-callstack-brownfield/ios && xcodegen generate && pod install
pnpm --filter bridgekit-example-callstack-brownfield package:ios
# then open HostApp and add the produced *.xcframework

# Android: package + publish the AAR, then build the host against mavenLocal
pnpm --filter bridgekit-example-callstack-brownfield package:android
pnpm --filter bridgekit-example-callstack-brownfield publish:android
cd apps/example-callstack-brownfield/android && ./gradlew :host:installDebug

# Metro for dev
pnpm --filter bridgekit-example-callstack-brownfield start
```

See `ios/README.md` and `android/README.md` for the detailed packaging sequence.

## First-build checks (not verifiable without compiling)

- `brownfield-gradle-plugin` version: pinned to stable **1.1.0** (Maven Central also lists
  `2.0.0-alpha01`). If the CLI 3.12.0 requires plugin 2.x, bump the classpath.
- `loadReactNative` import is emitted by the brownfield Gradle plugin during `package:android`;
  it exists only after that task runs.
- iOS: confirm the exact `hermesvm.xcframework` filename and the xcframework output path from the
  actual `package:ios` output before wiring them into the host.
- Compose BOM / Material versions resolve on first sync.
