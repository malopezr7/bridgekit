package com.bridgekit.callstackbrownfield.host

import android.app.Application
import android.util.Log
import com.bridgekit.callstackbrownfield.ReactNativeHostManager

/**
 * Host Application — the ONLY entry point the native host app needs to touch.
 * All RN + BridgeKit wiring is encapsulated inside the :reactnativeapp AAR.
 *
 * The host app has NO Node.js, NO Metro, NO react-native-community/cli.
 * It just calls ReactNativeHostManager.initialize() which is exported from the AAR.
 */
class HostApplication : Application() {

    override fun onCreate() {
        super.onCreate()

        // Initialize React Native + BridgeKit from the AAR.
        // This starts loading the embedded JS bundle in the background.
        ReactNativeHostManager.initialize(this) {
            Log.i("HostApp", "React Native JS bundle loaded")
        }
    }
}
