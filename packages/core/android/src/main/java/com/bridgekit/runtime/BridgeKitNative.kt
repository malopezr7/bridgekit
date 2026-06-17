package com.bridgekit.runtime

/**
 * Singleton seam between the Nitro Hybrid objects (Slice C) and the BridgeKit
 * Kotlin core (Slice D). HybridBridgeHost / HybridBridgeStreams / HybridBridgeState
 * delegate every call here.
 *
 * Defaults to [NotReadyDelegate] which returns BRIDGE_NOT_READY envelopes for
 * all calls and is a no-op for fire-and-forget paths.
 *
 * Slice D wires in a real implementation via:
 *   BridgeKitNative.delegate = realDelegate
 */
object BridgeKitNative {
    @Volatile
    var delegate: BridgeKitNativeDelegate = NotReadyDelegate
}

/**
 * Full delegate surface exposed to the Kotlin core (Slice D).
 * All Map<String, Any?> values conform to the { v: <value> } wire rule
 * documented in the BridgeHost / BridgeState specs.
 */
interface BridgeKitNativeDelegate {
    // ---- BridgeHost ----------------------------------------------------------

    /**
     * Async invoke. Calls [complete] exactly once with the result envelope map.
     */
    fun invoke(env: Map<String, Any?>, complete: (Map<String, Any?>) -> Unit)

    /**
     * Synchronous invoke — only lock-free in-memory reads are permitted.
     * Returns a result envelope map.
     */
    fun invokeSync(env: Map<String, Any?>): Map<String, Any?>

    /**
     * Register the JS dispatcher for a new runtime epoch.
     * Returns { epoch: Number, snapshot: List<Map<String,Any?>> } as a map.
     */
    fun connectDispatcher(
        epochInfo: Map<String, Any?>,
        callbacks: JsDispatcherCallbacks,
    ): Map<String, Any?>

    // ---- BridgeStreams -------------------------------------------------------

    /**
     * Open a native→JS stream. Returns the stream id (epoch-scoped).
     */
    fun openStream(
        env: Map<String, Any?>,
        onNext: (Map<String, Any?>) -> Unit,
        onEnd: (Map<String, Any?>) -> Unit,
    ): String

    /** Cancel a native→JS stream from the JS side. */
    fun closeStream(streamId: String)

    /**
     * Push a value from the JS producer to the Kotlin consumer.
     * value is wrapped { v: <encoded-value> }.
     */
    fun emitFromJs(streamId: String, value: Map<String, Any?>)

    /**
     * Signal end-of-stream from the JS producer.
     * end is a ResultEnvelope map.
     */
    fun endFromJs(streamId: String, end: Map<String, Any?>)

    // ---- BridgeState --------------------------------------------------------

    /** Synchronous state read. Returns a ResultEnvelope map. */
    fun stateRead(env: Map<String, Any?>): Map<String, Any?>

    /**
     * Subscribe to state changes. Returns obsId.
     * onChange receives { v: <encoded-value> }.
     */
    fun stateObserve(env: Map<String, Any?>, onChange: (Map<String, Any?>) -> Unit): String

    /** Cancel a state observation. */
    fun stateUnobserve(obsId: String)

    /**
     * Provider-side state write from JS.
     * Returns a ResultEnvelope map. Rejects with NOT_PROVIDER if the caller
     * doesn't own the binding.
     */
    fun stateWrite(env: Map<String, Any?>): Map<String, Any?>
}

/**
 * Callbacks that the Kotlin dispatcher passes back to JS.
 * The double-Promise from the Nitro callback (onInvoke) is encapsulated HERE:
 * [onInvoke] exposes a plain completion-callback API; HybridBridgeHost
 * adapts the Nitro Func_* + Promise plumbing.
 */
class JsDispatcherCallbacks(
    /**
     * Route a native→JS method call.
     * Call [completion] with (result, null) on success or (null, err) on failure.
     * Never throws — implementations must catch all exceptions.
     */
    val onInvoke: (
        env: Map<String, Any?>,
        completion: (ok: Map<String, Any?>?, err: Throwable?) -> Unit,
    ) -> Unit,

    /** Signal a JS-provided stream to start emitting. env carries the open envelope. */
    val onStreamOpen: (env: Map<String, Any?>) -> Unit,

    /**
     * Signal teardown of a native-side stream consumer.
     * env = { streamId: String, reason: String }.
     */
    val onStreamClose: (env: Map<String, Any?>) -> Unit,

    /** Push a state-change notification to JS mirrors. env is the StateWrite envelope. */
    val onStateWrite: (env: Map<String, Any?>) -> Unit,
)

// ---- NotReadyDelegate -------------------------------------------------------

private const val BRIDGE_NOT_READY_MSG = "BridgeKit native core not initialized. " +
    "Ensure the JS bundle entry imports '@malopezr7/bridgekit' before the first call."

private fun notReadyEnvelope(): Map<String, Any?> = mapOf(
    "ok" to false,
    "code" to "BRIDGE_NOT_READY",
    "message" to BRIDGE_NOT_READY_MSG,
)

/**
 * Default delegate — returns BRIDGE_NOT_READY envelopes until Slice D wires in the real impl.
 */
object NotReadyDelegate : BridgeKitNativeDelegate {
    override fun invoke(env: Map<String, Any?>, complete: (Map<String, Any?>) -> Unit) {
        complete(notReadyEnvelope())
    }

    override fun invokeSync(env: Map<String, Any?>): Map<String, Any?> = notReadyEnvelope()

    override fun connectDispatcher(
        epochInfo: Map<String, Any?>,
        callbacks: JsDispatcherCallbacks,
    ): Map<String, Any?> = mapOf(
        "epoch" to 0,
        "snapshot" to emptyList<Map<String, Any?>>(),
    )

    override fun openStream(
        env: Map<String, Any?>,
        onNext: (Map<String, Any?>) -> Unit,
        onEnd: (Map<String, Any?>) -> Unit,
    ): String {
        onEnd(notReadyEnvelope())
        return ""
    }

    override fun closeStream(streamId: String) { /* no-op */ }

    override fun emitFromJs(streamId: String, value: Map<String, Any?>) { /* no-op */ }

    override fun endFromJs(streamId: String, end: Map<String, Any?>) { /* no-op */ }

    override fun stateRead(env: Map<String, Any?>): Map<String, Any?> = notReadyEnvelope()

    override fun stateObserve(env: Map<String, Any?>, onChange: (Map<String, Any?>) -> Unit): String = ""

    override fun stateUnobserve(obsId: String) { /* no-op */ }

    override fun stateWrite(env: Map<String, Any?>): Map<String, Any?> = notReadyEnvelope()
}
