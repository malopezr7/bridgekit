package com.bridgekit.expobrownfield

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import expo.modules.ReactActivityDelegateWrapper

// ---------------------------------------------------------------------------
// ReactScreenActivity — hosts the BridgeKit RN screen inside the existing native app.
//
// Launched from NativeHomeActivity via startActivity(). React Native owns the
// window while this activity is foregrounded; the system Back button returns to
// the native home screen. The ReactHost is the shared one built in MainApplication,
// so there is no per-screen cold start.
//
// Expo integrated brownfield wraps the delegate in ReactActivityDelegateWrapper so
// Expo modules receive activity lifecycle callbacks (verified against
// Axion.Framework AxionFeatureActivity.kt and the official Expo brownfield docs).
//
// moduleName "BridgeKitExpoBrownfield" matches index.js AppRegistry.registerComponent.
// ---------------------------------------------------------------------------
class ReactScreenActivity : ReactActivity() {

    override fun getMainComponentName(): String = "BridgeKitExpoBrownfield"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        ReactActivityDelegateWrapper(
            this,
            BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
            DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled),
        )
}
