package com.bridgekit.expobrownfield

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

// ---------------------------------------------------------------------------
// NativeHomeActivity — the "existing native app" home screen.
//
// This activity is the MAIN/LAUNCHER entry point. It is 100% native Kotlin /
// Jetpack Compose — there is no React Native involved here. This demonstrates
// the brownfield scenario: the user's existing app has its own native UI and
// can embed an RN screen on demand via a button tap.
// ---------------------------------------------------------------------------
class NativeHomeActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    NativeHomeScreen(
                        onOpenRnDemo = {
                            startActivity(Intent(this, ReactScreenActivity::class.java))
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun NativeHomeScreen(onOpenRnDemo: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "Native Android App",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "This is the existing native host app.",
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )

        Spacer(modifier = Modifier.height(4.dp))

        Text(
            text = "The React Native screen below is embedded via the brownfield integrated approach — it shares the same JS engine and Metro bundle.",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(modifier = Modifier.height(32.dp))

        HorizontalDivider()

        Spacer(modifier = Modifier.height(32.dp))

        Button(
            onClick = onOpenRnDemo,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(text = "Open BridgeKit RN demo")
        }

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Tap the button above to launch the BridgeKit React Native screen.\nThe RN screen uses BridgeKit (a Nitro Module) to communicate back to this native host.",
            style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
