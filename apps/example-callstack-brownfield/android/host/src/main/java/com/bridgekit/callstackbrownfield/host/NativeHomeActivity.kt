package com.bridgekit.callstackbrownfield.host

import android.os.Bundle
import androidx.fragment.app.FragmentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.callstack.reactnativebrownfield.ReactNativeFragment

/**
 * Native home screen — a pure Jetpack Compose activity with NO RN dependency.
 * The host app requires no Node.js, no Metro, and no react-native imports.
 *
 * The "Open BridgeKit RN demo" button presents a ReactNativeFragment from the
 * :reactnativeapp AAR, rendering the "BridgeKitCallstackBrownfield" AppRegistry component.
 *
 * Uses Kotlin 2.x Compose compiler plugin:
 *   - root build.gradle: classpath org.jetbrains.kotlin:compose-compiler-gradle-plugin
 *   - host/build.gradle: apply plugin "org.jetbrains.kotlin.plugin.compose"
 *   - NO composeOptions.kotlinCompilerExtensionVersion (Kotlin 1.9 only)
 */
class NativeHomeActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    HomeScreen(onOpenRnDemo = ::openRnDemo)
                }
            }
        }
    }

    private fun openRnDemo() {
        // The module name must match the AppRegistry.registerComponent() call in index.js:
        // AppRegistry.registerComponent('BridgeKitCallstackBrownfield', ...)
        val rnFragment = ReactNativeFragment.createReactNativeFragment("BridgeKitCallstackBrownfield")

        // Add the fragment into the activity's view hierarchy.
        // We replace the entire content here; in a production app you'd use a fragment container.
        supportFragmentManager
            .beginTransaction()
            .replace(android.R.id.content, rnFragment)
            .addToBackStack("rn_demo")
            .commit()
    }
}

@Composable
private fun HomeScreen(onOpenRnDemo: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "BridgeKit Brownfield Host",
            style = MaterialTheme.typography.headlineMedium,
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "Pure native app — no Node.js, no Metro",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(modifier = Modifier.height(32.dp))
        Button(onClick = onOpenRnDemo) {
            Text("Open BridgeKit RN demo")
        }
    }
}
