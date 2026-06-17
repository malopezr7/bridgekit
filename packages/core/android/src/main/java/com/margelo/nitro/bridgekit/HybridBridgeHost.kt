package com.margelo.nitro.bridgekit

import androidx.annotation.Keep
import com.bridgekit.runtime.BridgeKitNative
import com.bridgekit.runtime.JsDispatcherCallbacks
import com.bridgekit.codec.AnyMapCodec
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.core.AnyMap
import com.margelo.nitro.core.Promise

/**
 * Nitro Hybrid implementation for BridgeHost.
 *
 * All calls delegate to [BridgeKitNative.delegate].
 *
 * Double-Promise adapter:
 * Nitro generates `onInvoke` as `(AnyMap) -> Promise<Promise<AnyMap>>` because:
 *   1. The JS callback itself is async → inner Promise<AnyMap>
 *   2. Nitro wraps the cross-thread call in another Promise → outer layer
 * We bridge this to [JsDispatcherCallbacks.onInvoke]'s completion-callback API
 * by calling `.await().await()` inside a `Promise.async {}` block.
 */
@DoNotStrip
@Keep
class HybridBridgeHost : HybridBridgeHostSpec() {

    // ---- invoke --------------------------------------------------------------

    /**
     * Async invoke — returns a Promise resolved by the delegate's completion callback.
     */
    override fun invoke(env: AnyMap): Promise<AnyMap> = Promise.async {
        val map = AnyMapCodec.fromAnyMap(env)
        val resultPromise = Promise<AnyMap>()

        BridgeKitNative.delegate.invoke(map) { result ->
            resultPromise.resolve(
                AnyMapCodec.toAnyMap(
                    result ?: mapOf(
                        "ok" to false,
                        "code" to "BRIDGE_NOT_READY",
                        "message" to "invoke completion never called",
                    )
                )
            )
        }

        resultPromise.await()
    }

    // ---- invokeSync ----------------------------------------------------------

    override fun invokeSync(env: AnyMap): AnyMap {
        val map = AnyMapCodec.fromAnyMap(env)
        val result = BridgeKitNative.delegate.invokeSync(map)
        return AnyMapCodec.toAnyMap(result)
    }

    // ---- connectDispatcher ---------------------------------------------------

    /**
     * Register the JS dispatcher. Synchronous — returns epoch + snapshot.
     *
     * The [onInvoke] parameter has the Nitro double-Promise signature:
     *   (AnyMap) -> Promise<Promise<AnyMap>>
     *
     * We wrap it for [JsDispatcherCallbacks]: the adapter starts a
     * `Promise.async {}` coroutine that awaits both promise layers, then
     * calls the completion callback. This keeps all awaiting off the JS thread
     * and ensures the seam always calls `completion` exactly once (never throws).
     */
    override fun connectDispatcher(
        epochInfo: AnyMap,
        onInvoke: (env: AnyMap) -> Promise<Promise<AnyMap>>,
        onStreamOpen: (env: AnyMap) -> Unit,
        onStreamClose: (env: AnyMap) -> Unit,
        onStateWrite: (env: AnyMap) -> Unit,
    ): AnyMap {
        val callbacks = JsDispatcherCallbacks(
            onInvoke = { envMap, completion ->
                val nitroEnv = AnyMapCodec.toAnyMap(envMap)
                // Use Promise.async to suspend through both await() layers
                // without blocking any thread.
                Promise.async {
                    try {
                        val outerPromise = onInvoke(nitroEnv)
                        val innerPromise = outerPromise.await()
                        val resultAnyMap = innerPromise.await()
                        completion(AnyMapCodec.fromAnyMap(resultAnyMap), null)
                    } catch (err: Throwable) {
                        completion(null, err)
                    }
                }
                Unit
            },
            onStreamOpen = { envMap ->
                onStreamOpen(AnyMapCodec.toAnyMap(envMap))
            },
            onStreamClose = { envMap ->
                onStreamClose(AnyMapCodec.toAnyMap(envMap))
            },
            onStateWrite = { envMap ->
                onStateWrite(AnyMapCodec.toAnyMap(envMap))
            },
        )

        val result = BridgeKitNative.delegate.connectDispatcher(
            AnyMapCodec.fromAnyMap(epochInfo),
            callbacks,
        )
        return AnyMapCodec.toAnyMap(result)
    }
}
