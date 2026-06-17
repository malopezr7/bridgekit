package com.bridgekit.diagnostics

import android.util.Log
import java.util.concurrent.atomic.AtomicLong

/**
 * Structured diagnostics for BridgeKit operations.
 *
 * Logcat format (single line per entry):
 *   op|contract|member|scope|code|durMs|epoch
 *
 * Gated by [devTracing] (default: BuildConfig.DEBUG).
 * Counters (drops, failures) always increment regardless of tracing flag.
 */
object BridgeKitDiagnostics {

    private const val TAG = "BridgeKit"

    /** Enable structured logcat traces. Defaults to BuildConfig.DEBUG at init. */
    @Volatile
    var devTracing: Boolean = try {
        // Use reflection to avoid hard dependency on BuildConfig at test time.
        val cls = Class.forName("com.bridgekit.BuildConfig")
        cls.getField("DEBUG").getBoolean(null)
    } catch (_: Exception) {
        false
    }

    // ---- counters ----------------------------------------------------------------

    private val _dropCount = AtomicLong(0)
    private val _fireFailCount = AtomicLong(0)

    val dropCount: Long get() = _dropCount.get()
    val fireFailCount: Long get() = _fireFailCount.get()

    fun recordDrop() { _dropCount.incrementAndGet() }
    fun recordFireFail() { _fireFailCount.incrementAndGet() }

    // ---- trace -------------------------------------------------------------------

    fun trace(
        op: String,
        contractId: String,
        member: String = "",
        scope: String = "",
        code: String = "OK",
        durMs: Long = 0,
        epoch: Long = 0,
    ) {
        if (!devTracing) return
        Log.d(TAG, "$op|$contractId|$member|$scope|$code|$durMs|$epoch")
    }

    fun dumpCounters(): String = "drops=$_dropCount fireFailures=$_fireFailCount"

    fun reset() {
        _dropCount.set(0)
        _fireFailCount.set(0)
    }
}
