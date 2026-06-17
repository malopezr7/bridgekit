package io.github.malopezr7.bridgekit

import io.github.malopezr7.bridgekit.runtime.JsDispatcherCallbacks
import java.util.concurrent.CopyOnWriteArrayList

/**
 * W0-3: Thin stub for JsDispatcherCallbacks.
 *
 * Records all invocations so SeamRoundTripTest can assert on them without a real JS runtime.
 * Supports setting canned responses for invoke calls.
 */
class StubJsDispatcher {

    /** Records of native→JS invoke calls. Each entry is the env map. */
    val invocations = CopyOnWriteArrayList<Map<String, Any?>>()

    /** Records of stream open envelopes (native asks JS to start streaming). */
    val streamOpens = CopyOnWriteArrayList<Map<String, Any?>>()

    /** Records of stream close envelopes (native tells JS to stop streaming). */
    val streamCloses = CopyOnWriteArrayList<Map<String, Any?>>()

    /** Records of state write envelopes pushed by native to JS mirrors. */
    val stateWrites = CopyOnWriteArrayList<Map<String, Any?>>()

    /**
     * Canned response for the next invoke call. If null, returns a successful
     * empty-value envelope so tests that don't care about the result still work.
     */
    @Volatile
    var nextInvokeResponse: Map<String, Any?>? = null

    /**
     * Build the [JsDispatcherCallbacks] that routes into this stub.
     */
    fun asCallbacks(): JsDispatcherCallbacks = JsDispatcherCallbacks(
        onInvoke = { env, complete ->
            invocations.add(env)
            val response = nextInvokeResponse ?: mapOf("ok" to true, "value" to null)
            complete(response, null)
        },
        onStreamOpen = { env ->
            streamOpens.add(env)
        },
        onStreamClose = { env ->
            streamCloses.add(env)
        },
        onStateWrite = { env ->
            stateWrites.add(env)
        },
    )

    fun reset() {
        invocations.clear()
        streamOpens.clear()
        streamCloses.clear()
        stateWrites.clear()
        nextInvokeResponse = null
    }
}
