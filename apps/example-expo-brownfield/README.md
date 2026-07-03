# bridgekit-example-expo-brownfield

BridgeKit embedded into an **existing native app via Expo** — the *integrated* brownfield approach.

An existing native iOS (Swift/UIKit) and Android (Kotlin/Jetpack Compose) app owns its home
screen. A button opens a React Native screen — embedded with Expo's integrated brownfield wiring —
that talks to native through **BridgeKit** (built on Nitro Modules). The RN surface is the same
demo as `apps/example` (native→JS ping / increment / ticker / counter, JS→native info, local state).

## Stack

| | |
|---|---|
| Expo SDK | 55 (`~55.0.26`) |
| React Native | 0.83.6 |
| React | 19.2.0 |
| Nitro | react-native-nitro-modules 0.35.0 |
| Architecture | New Architecture + Hermes (required by Nitro) |

**Why SDK 55 and not 56?** SDK 55 pairs with RN 0.83, which matches BridgeKit's pinned RN 0.83.6
and its generated codegen. The whole pnpm monorepo shares a single RN version, so the example is
anchored to BridgeKit — it moves to SDK 56 / RN 0.85+ only when BridgeKit does.

## Layout

```
index.js                  AppRegistry.registerComponent("BridgeKitExpoBrownfield", App)
src/                      shared demo UI + contracts (cloned from apps/example)
app.json, metro/babel     Expo toolchain (newArchEnabled, expo/metro-config, babel-preset-expo)
ios/                      existing native app (xcodegen project.yml + Podfile)
  BridgeKitExpoBrownfield/
    AppDelegate.swift        native entry; calls BridgekitDemoInitializer.configure() first
    HomeViewController.swift native home screen with "Open BridgeKit RN demo"
    ReactViewController.swift hosts the RN root view
    ReactNativeFactory.mm    RCTReactNativeFactory + RCTDefaultReactNativeFactoryDelegate
    Generated/*.swift        CLI-generated contract glue
android/                  existing native app
  app/src/main/java/com/bridgekit/expobrownfield/
    MainApplication.kt       ExpoReactHostFactory.getDefaultReactHost + loadReactNative
    NativeHomeActivity.kt    Compose home screen with "Open BridgeKit RN demo"
    ReactScreenActivity.kt   ReactActivity + ReactActivityDelegateWrapper
    bridgekit/               BridgekitDemoInitializer + DemoHostImpl
    generated/*.kt           CLI-generated contract glue
```

## Brownfield wiring — the bits that matter

- **iOS** uses the official Expo integrated factory: `RCTReactNativeFactory` +
  `RCTDefaultReactNativeFactoryDelegate` + `RCTAppDependencyProvider`, bundle root
  `.expo/.virtual-metro-entry`. `BridgekitDemoInitializer.configure()` runs before any RN view.
- **Android** uses `ExpoReactHostFactory.getDefaultReactHost(...)` + `loadReactNative(this)` +
  `ApplicationLifecycleDispatcher`; the RN-hosting Activity wraps its delegate in
  `ReactActivityDelegateWrapper`. Pattern verified against a real in-production Expo brownfield app.
- **BridgeKit (Nitro) is linked manually**: `BridgeKitPackage()` is NOT in the autolinked
  `PackageList`, so `MainApplication` adds it explicitly. Native providers are registered
  (`BridgekitDemoInitializer.init(...)`) before the JS bundle runs. iOS mirrors this in `AppDelegate`.

## Build & run

> Not executed in this repo (the working policy here is "never build"). Sequence:

```bash
# from repo root
pnpm install

# regenerate contract glue (optional — committed output already present)
pnpm --filter bridgekit-example-expo-brownfield generate       # Kotlin
pnpm --filter bridgekit-example-expo-brownfield generate:ios    # Swift

# Metro (Expo dev server)
pnpm --filter bridgekit-example-expo-brownfield start

# iOS
cd apps/example-expo-brownfield/ios && xcodegen generate && pod install && open *.xcworkspace

# Android
cd apps/example-expo-brownfield/android && ./gradlew :app:installDebug
```

## First-build checks (not verifiable without compiling)

- Expo classes (`expo.modules.ExpoReactHostFactory`, `ApplicationLifecycleDispatcher`,
  `ReactActivityDelegateWrapper`) resolve only after `pnpm install`.
- `xcodegen` and `pod install` must be run before opening Xcode; CocoaPods rewrites the
  generated `.xcodeproj` script phases (expected).
- `RCTReactNativeFactory.rootViewFactory` selector and the bundle script phase names should be
  confirmed against the RN 0.83.6 pods on first build.
