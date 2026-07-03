package com.bridgekit.callstackbrownfield

import android.app.Application
import android.content.pm.ApplicationInfo
import com.bridgekit.BridgeKitPackage
import com.bridgekit.callstackbrownfield.bridgekit.BridgekitDemoInitializer
import com.bridgekit.discovery.BridgeKitHost
import com.callstack.reactnativebrownfield.OnJSBundleLoaded
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.callstack.reactnativebrownfield.ReactNativeBrownfieldPackage
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import com.margelo.nitro.NitroModulesPackage
import java.io.IOException

/**
 * Initializes the React Native runtime and BridgeKit for the brownfield AAR.
 *
 * Call from the host app's Application.onCreate() BEFORE any activity is created:
 *
 *   ReactNativeHostManager.initialize(this) { /* JS bundle ready */ }
 *
 * Wiring order mirrors apps/example/android/app/src/main/java/com/bridgekit/example/MainApplication.kt:
 *   1. load React Native native libraries  — required for RN >= 0.80
 *   2. BridgekitDemoInitializer.init(...)  — registers native providers BEFORE JS executes
 *   3. ReactNativeBrownfield.initialize()  — starts the JS bundle load
 */
object ReactNativeHostManager {

    fun initialize(application: Application, onJSBundleLoaded: OnJSBundleLoaded? = null) {
        // Step 1 — load RN native libraries. The generated
        // ReactNativeApplicationEntryPoint is only wired for Android application
        // modules by the RN Gradle plugin; this module is a library AAR.
        try {
            SoLoader.init(application, OpenSourceMergedSoMapping)
        } catch (error: IOException) {
            throw RuntimeException(error)
        }
        DefaultNewArchitectureEntryPoint.load()

        // Step 2 — initialize BridgeKit BEFORE the JS bundle loads so the dispatcher is ready.
        // Mirrors MainApplication.kt: BridgekitDemoInitializer.init(BridgeKitHost(applicationContext) { null })
        BridgekitDemoInitializer.init(BridgeKitHost(application) { null })

        // Step 3 — build the package list manually. The brownfield module is an AAR library
        // (not a normal RN :app project), so relying on a generated PackageList is fragile.
        // Keep BridgeKitPackage manual and before JS executes; Nitro is the runtime substrate.
        val packages: List<ReactPackage> = listOf(
            ReactNativeBrownfieldPackage(),
            NitroModulesPackage(),
            BridgeKitPackage(),
        )

        val useDeveloperSupport =
            (application.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

        val options = hashMapOf<String, Any>(
            "packages" to packages,
            "mainModuleName" to "index",
            "useDeveloperSupport" to useDeveloperSupport,
            "bundleAssetPath" to "index.android.bundle",
        )

        // Step 4 — hand off to Brownfield which creates the ReactHost and loads the JS bundle.
        ReactNativeBrownfield.initialize(application, options, onJSBundleLoaded)
    }
}
