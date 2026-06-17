package com.bridgekit.example.bridgekit

import android.util.Log
import com.bridgekit.example.generated.BridgekitDemoFeatureContract
import com.bridgekit.example.generated.BridgekitDemoHostContract
import com.bridgekit.example.generated.BridgekitDemoReverseContract
import com.bridgekit.example.generated.GetGreetingParams
import com.bridgekit.example.generated.GreetFromJsParams
import com.bridgekit.example.generated.OnNativeEventParams
import io.github.malopezr7.bridgekit.core.BridgeKit
import io.github.malopezr7.bridgekit.core.Scope
import io.github.malopezr7.bridgekit.discovery.BridgeKitHost
import io.github.malopezr7.bridgekit.runtime.BridgeValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.launch

private const val TAG = "BridgeKitDemo"
private const val TAG_REVERSE = "BridgeKitReverse"
private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/**
 * Initializes BridgeKit for the example app.
 * Called from MainApplication.onCreate BEFORE React initializes.
 */
object BridgekitDemoInitializer {

    fun init(host: BridgeKitHost) {
        val bridgeKit = BridgeKit.default
        // Run ServiceLoader discovery (no-op if no META-INF/services present)
        try {
            bridgeKit.initialize(host)
        } catch (e: Exception) {
            Log.w(TAG, "ServiceLoader discovery failed (expected in bare app): ${e.message}")
        }

        // Provide the native demo-host contract at Global scope
        bridgeKit.provide(
            definition = BridgekitDemoHostContract,
            scope = Scope.Global,
            eager = true,
        ) {
            DemoHostImpl()
        }
        Log.i(TAG, "BridgeKit: DemoHost provided at Global scope")

        // After a delay, consume the JS-provided demo-feature contract and call getGreeting.
        // Validates the JS-provides / native-consumes Async direction (cross-direction scenario).
        appScope.launch {
            delay(15_000)
            try {
                val feature = bridgeKit.consume(BridgekitDemoFeatureContract, Scope.Global)
                val result = feature.getGreeting(GetGreetingParams(name = "BridgeKit"))
                Log.i(TAG, "JS said: $result")
            } catch (e: Exception) {
                Log.e(TAG, "native→JS consume failed: ${e.message}", e)
            }
        }

        // Consume the JS-provided demo-reverse contract.
        // Exercises ALL four marker directions (JS provides, native consumes):
        //   Async  — greetFromJs
        //   Void   — onNativeEvent
        //   Stream — jsCounter
        //   State  — jsStatus
        appScope.launch {
            try {
                val reverse = bridgeKit.consume(BridgekitDemoReverseContract, Scope.Global)

                // ---- Async (doubles as the readiness probe) ----
                // The RN bundle can take a while to load+execute on the emulator,
                // so retry until the JS dispatcher has provided the contract (up to ~90 s).
                val deadline = System.currentTimeMillis() + 90_000
                var asyncOk = false
                while (!asyncOk && System.currentTimeMillis() < deadline) {
                    try {
                        val greeting = reverse.greetFromJs(GreetFromJsParams(name = "Android"))
                        Log.i(TAG_REVERSE, "async=$greeting")
                        asyncOk = true
                    } catch (e: Exception) {
                        delay(3_000)
                    }
                }
                if (!asyncOk) Log.e(TAG_REVERSE, "async never became ready within 90s")

                // ---- Void (fire-and-forget from native's perspective) ----
                try {
                    reverse.onNativeEvent(OnNativeEventParams(type = "native-tap", payload = "button_a"))
                    Log.i(TAG_REVERSE, "void fired type=native-tap")
                } catch (e: Exception) {
                    Log.e(TAG_REVERSE, "void fire failed: ${e.message}", e)
                }

                // ---- Stream: collect first 5 ticks from the JS counter ----
                reverse.jsCounter()
                    .take(5)
                    .onEach { v -> Log.i(TAG_REVERSE, "stream tick=$v") }
                    .catch { e -> Log.e(TAG_REVERSE, "stream failed: ${e.message}") }
                    .launchIn(appScope)

                // ---- State: observe jsStatus until cancelled ----
                reverse.jsStatus
                    .catch { e -> Log.e(TAG_REVERSE, "state failed: ${e.message}") }
                    .onEach { bv ->
                        when (bv) {
                            is BridgeValue.Available ->
                                Log.i(TAG_REVERSE, "state=${bv.value}")
                            is BridgeValue.Initial ->
                                Log.i(TAG_REVERSE, "state=initial(${bv.value})")
                            is BridgeValue.Replacing ->
                                Log.i(TAG_REVERSE, "state=replacing(${bv.lastKnown})")
                            is BridgeValue.Unprovided ->
                                Log.i(TAG_REVERSE, "state=unprovided(${bv.lastKnown})")
                        }
                    }
                    .launchIn(appScope)

            } catch (e: Exception) {
                Log.e(TAG_REVERSE, "reverse consume failed: ${e.message}", e)
            }
        }

        Log.i(TAG, "BridgeKit initialized. dump=${bridgeKit.dump()}")
    }
}
