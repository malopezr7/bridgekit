package com.bridgekit.expobrownfield

import android.app.Application
import com.bridgekit.BridgeKitPackage
import com.bridgekit.discovery.BridgeKitHost
import com.bridgekit.expobrownfield.bridgekit.BridgekitDemoInitializer
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

// ---------------------------------------------------------------------------
// MainApplication — Expo brownfield host (integrated approach, SDK 55 / RN 0.83).
//
// Native wiring verified against a real in-production Expo brownfield app
// (Axion.Framework ReactManager.kt) and the official Expo brownfield docs:
//   - ExpoReactHostFactory.getDefaultReactHost(...) builds the bridgeless ReactHost
//     and registers the autolinked Expo modules from PackageList.
//   - loadReactNative(this) is the RN 0.81+ entry point; it replaces the manual
//     SoLoader.init + DefaultNewArchitectureEntryPoint.load() pair.
//   - ApplicationLifecycleDispatcher.onApplicationCreate hooks Expo modules into
//     the Application lifecycle.
//
// BridgeKit-specific wiring (replicated from apps/example/android MainApplication.kt):
//   - BridgeKitPackage() is a Nitro module and is NOT part of the autolinked
//     PackageList, so it is added to the package list MANUALLY.
//   - BridgekitDemoInitializer.init(host) registers the native-provided contracts
//     BEFORE the JS bundle runs (after loadReactNative, so the Nitro JNI layer is up).
// ---------------------------------------------------------------------------
class MainApplication : Application(), ReactApplication {

    override val reactHost: ReactHost
        get() = ExpoReactHostFactory.getDefaultReactHost(
            context = applicationContext,
            packageList = PackageList(this).packages.apply {
                // MANUAL: Nitro module — not discovered by PackageList autolinking.
                add(BridgeKitPackage())
            },
            // Expo integrated brownfield entry: Metro serves this virtual entry in DEBUG.
            // Matches the iOS bundle root in ReactNativeFactory.mm (.expo/.virtual-metro-entry).
            jsMainModulePath = ".expo/.virtual-metro-entry",
            jsBundleFilePath = null,
            useDevSupport = BuildConfig.DEBUG,
        )

    override fun onCreate() {
        super.onCreate()
        ApplicationLifecycleDispatcher.onApplicationCreate(this)
        loadReactNative(this)
        // BridgeKit native providers must be registered before JS consumes them.
        BridgekitDemoInitializer.init(BridgeKitHost(applicationContext) { null })
    }
}
