package io.github.malopezr7.bridgekit.core

import io.github.malopezr7.bridgekit.runtime.BridgeValue
import io.github.malopezr7.bridgekit.runtime.OutboundCaller
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * OutboundCaller implementation for native consuming JS-provided contracts.
 *
 * All suspend calls:
 *  1. Await dispatcher connected (readiness bounded by [readinessTimeoutMs])
 *  2. Call into JS via JsDispatcherCallbacks.onInvoke
 *  3. Wait for completion with [callTimeoutMs] timeout
 *
 * Main-thread guard: if readiness wait would block and we are on the main thread,
 * throw IllegalStateException immediately.
 */
internal class OutboundCallerImpl(
    private val contractId: String,
    private val scope: Scope,
    private val router: Router,
    private val mainThreadChecker: MainThreadChecker = AndroidMainThreadChecker,
    private val readinessTimeoutMs: Long = 10_000,
    private val callTimeoutMs: Long = 30_000,
) : OutboundCaller {

    companion object {
        private val streamIdCounter = AtomicLong(0)
    }

    // Fire-and-forget dispatch scope (off the calling thread, supervised so one
    // failed fire never cancels the others).
    private val fireScope =
        kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default,
        )

    override fun fire(member: String, payload: Map<String, Any?>?) {
        fireScope.launch {
            try {
                invoke(member, payload)
            } catch (_: Throwable) {
                // fire-and-forget: errors are swallowed
            }
        }
    }

    override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? {
        // Main-thread guard
        if (mainThreadChecker.isMainThread()) {
            throw IllegalStateException(
                "BridgeKit: suspend consume() call on the main thread for contract '$contractId'." +
                    " This will cause an ANR. Use a coroutine or launch from a background thread.",
            )
        }

        // Wait for JS dispatcher to be available
        val callbacks = awaitDispatcher()

        val env = buildEnvelope("invoke", member, payload)
        val result = CompletableDeferred<Map<String, Any?>>()

        callbacks.onInvoke(env) { ok, err ->
            if (err != null) {
                result.complete(
                    Router.errEnv("PROVIDER_ERROR", err.message ?: "JS invoke error", contractId, member, scope),
                )
            } else {
                result.complete(ok ?: Router.errEnv("PROVIDER_ERROR", "null result from JS", contractId, member, scope))
            }
        }

        val raw = try {
            withTimeout(callTimeoutMs) { result.await() }
        } catch (_: TimeoutCancellationException) {
            throw BridgeKitException("TIMEOUT", "JS call to '$member' on '$contractId' timed out after ${callTimeoutMs}ms", contractId, member, scope)
        }

        if (raw["ok"] == true) return raw["value"]
        throw BridgeKitException.fromEnvelope(raw, contractId)
    }

    override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? {
        throw UnsupportedOperationException(
            "invokeSync is not supported for JS-provided contracts (contract: '$contractId', member: '$member'). " +
                "JS cannot be called synchronously from native.",
        )
    }

    override fun stream(member: String, payload: Map<String, Any?>?): Flow<Any?> {
        return callbackFlow {
            // Readiness-bounded wait for the JS dispatcher — mirrors invoke()'s awaitDispatcher
            // so a native stream consumer that starts before JS has provided parks instead of
            // erroring instantly. On timeout the flow closes with BRIDGE_NOT_READY (the collector
            // must handle it; it is never thrown uncaught here).
            val callbacks =
                try {
                    awaitDispatcher()
                } catch (e: Throwable) {
                    close(e)
                    return@callbackFlow
                }

            val streamId = "js_${contractId}_${member}_${streamIdCounter.incrementAndGet()}"
            val channel = Channel<Map<String, Any?>>(capacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)
            val endDeferred = CompletableDeferred<Map<String, Any?>>()
            val endedByJs = AtomicBoolean(false)

            router.jsStreamChannels[streamId] = channel
            router.jsStreamEnds[streamId] = endDeferred

            val valuePump = launch {
                for (valueMap in channel) {
                    trySend(valueMap["v"])
                }
            }

            val endPump = launch {
                val end = endDeferred.await()
                endedByJs.set(true)
                if (end["ok"] == true) {
                    close()
                } else {
                    close(BridgeKitException.fromEnvelope(end, contractId))
                }
            }

            val openEnv = buildEnvelope("streamOpen", member, payload).toMutableMap()
            openEnv["streamId"] = streamId
            callbacks.onStreamOpen(openEnv)

            awaitClose {
                valuePump.cancel()
                endPump.cancel()
                channel.close()
                router.jsStreamChannels.remove(streamId)
                router.jsStreamEnds.remove(streamId)
                if (!endedByJs.get()) {
                    // When collector cancels, signal JS producer to stop
                    val closeEnv = mapOf<String, Any?>("streamId" to streamId, "reason" to "native-close")
                    callbacks.onStreamClose(closeEnv)
                }
            }
        }
    }

    override fun state(member: String): StateFlow<BridgeValue<Any?>> {
        return router.stateStore.getFlow(contractId, scope, member, null)
    }

    // ---- helpers ----------------------------------------------------------------

    private suspend fun awaitDispatcher(): io.github.malopezr7.bridgekit.runtime.JsDispatcherCallbacks {
        val immediate = router.getJsCallbacks()
        if (immediate != null) return immediate

        if (mainThreadChecker.isMainThread()) {
            throw IllegalStateException(
                "BridgeKit: waiting for JS dispatcher on the main thread for contract '$contractId'." +
                    " This will cause an ANR.",
            )
        }

        // Park until dispatcher or timeout
        return try {
            withTimeout(readinessTimeoutMs) {
                var cb = router.getJsCallbacks()
                while (cb == null) {
                    kotlinx.coroutines.delay(10)
                    cb = router.getJsCallbacks()
                }
                cb
            }
        } catch (_: TimeoutCancellationException) {
            throw BridgeKitException(
                "BRIDGE_NOT_READY",
                "JS dispatcher not connected within ${readinessTimeoutMs}ms for contract '$contractId'",
                contractId,
            )
        }
    }

    private fun buildEnvelope(op: String, member: String, payload: Map<String, Any?>?): Map<String, Any?> {
        return buildMap {
            put("op", op)
            put("contractId", contractId)
            put("member", member)
            put("scope", scopeToEnvMap(scope))
            put("correlationId", "native_${System.nanoTime()}")
            put("epoch", router.currentEpoch())
            if (payload != null) put("payload", payload)
        }
    }

    private fun scopeToEnvMap(scope: Scope): Map<String, Any?> = when (scope) {
        is Scope.Global -> mapOf("kind" to "global")
        is Scope.Feature -> mapOf("kind" to "feature", "feature" to scope.name)
        is Scope.Instance -> mapOf("kind" to "instance", "feature" to scope.feature, "instance" to scope.tag)
    }
}
