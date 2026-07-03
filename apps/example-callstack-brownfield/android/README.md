# BridgeKit Callstack Brownfield — Android

Packages a bare React Native project (with BridgeKit/Nitro) into an AAR using
`@callstack/react-native-brownfield`, then embeds it in a pure-Kotlin host app that has
no Node.js dependency.

## Architecture

```
apps/example-callstack-brownfield/
├── android/
│   ├── reactnativeapp/   ← Android Library module — packaged into the AAR
│   │   └── src/main/java/com/bridgekit/callstackbrownfield/
│   │       ├── ReactNativeHostManager.kt   ← public API consumed by the host
│   │       ├── bridgekit/
│   │       │   ├── BridgekitDemoInitializer.kt
│   │       │   └── DemoHostImpl.kt
│   │       └── generated/   ← BridgeKit contract glue (do not edit)
│   └── host/             ← Native host app — depends on the AAR only
│       └── src/main/java/com/bridgekit/callstackbrownfield/host/
│           ├── HostApplication.kt
│           └── NativeHomeActivity.kt
```

## Build sequence

### 1. Install JS dependencies (from monorepo root)

```bash
pnpm install
```

### 2. Package the AAR (from apps/example-callstack-brownfield/)

```bash
pnpm run package:android
# → npx brownfield package:android --variant Release --module-name reactnativeapp
```

This builds the Release AAR under `android/reactnativeapp/build/outputs/aar/`.

### 3. Publish to mavenLocal (from apps/example-callstack-brownfield/)

```bash
pnpm run publish:android
# → npx brownfield publish:android --module-name reactnativeapp
```

This pushes `com.bridgekit:reactnativeapp:1.0.0` into `~/.m2/repository/`.

### 4. Build the host app

Open `android/` in Android Studio and run the `:host` configuration, **or**:

```bash
cd android
./gradlew :host:assembleDebug
```

The host app has no Node.js dependency — it reads the AAR from mavenLocal.

## Key wiring points

| What | Where |
|------|-------|
| RN init (`loadReactNative` + `ReactNativeBrownfield.initialize`) | `ReactNativeHostManager.kt` |
| BridgeKitPackage registration (Nitro — not in PackageList) | `ReactNativeHostManager.kt` |
| BridgeKit provider setup (before JS loads) | `BridgekitDemoInitializer.kt` |
| Native DemoHost contract implementation | `DemoHostImpl.kt` |
| AppRegistry component name | `BridgeKitCallstackBrownfield` (see `index.js`) |

## Notes

- `brownfield-gradle-plugin:1.1.0` — latest stable on Maven Central (verified 2026-06-18).
- Compose compiler uses Kotlin 2.x plugin (`org.jetbrains.kotlin.plugin.compose`), NOT
  `composeOptions.kotlinCompilerExtensionVersion` (that is Kotlin 1.9 only).
- Generated contract files are in `reactnativeapp/src/main/java/com/bridgekit/callstackbrownfield/generated/`
  but their internal package is `io.github.malopezr7.bridgekit.contracts.*` — import from that.
