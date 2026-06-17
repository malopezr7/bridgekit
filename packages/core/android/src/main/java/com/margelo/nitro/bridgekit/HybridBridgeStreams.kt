package com.margelo.nitro.bridgekit

import androidx.annotation.Keep
import com.bridgekit.runtime.BridgeKitNative
import com.bridgekit.codec.AnyMapCodec
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.core.AnyMap

/**
 * Nitro Hybrid implementation for BridgeStreams.
 * Delegates all operations to [BridgeKitNative.delegate].
 */
@DoNotStrip
@Keep
class HybridBridgeStreams : HybridBridgeStreamsSpec() {

    /**
     * Open a native→JS stream.
     * Callbacks are held for the epoch lifetime by Nitro's reference-counting.
     * Returns an epoch-scoped stream id.
     */
    override fun open(env: AnyMap, onNext: (value: AnyMap) -> Unit, onEnd: (end: AnyMap) -> Unit): String {
        return BridgeKitNative.delegate.openStream(
            env = AnyMapCodec.fromAnyMap(env),
            onNext = { valueMap -> onNext(AnyMapCodec.toAnyMap(valueMap)) },
            onEnd = { endMap -> onEnd(AnyMapCodec.toAnyMap(endMap)) },
        )
    }

    /** Cancel a native→JS stream from the JS side. */
    override fun close(streamId: String) {
        BridgeKitNative.delegate.closeStream(streamId)
    }

    /**
     * Push a value from the JS producer to the Kotlin consumer.
     * value follows the { v: <encoded-value> } wire rule.
     */
    override fun emitFromJs(streamId: String, value: AnyMap) {
        BridgeKitNative.delegate.emitFromJs(streamId, AnyMapCodec.fromAnyMap(value))
    }

    /**
     * Signal end-of-stream from the JS producer.
     * end is a ResultEnvelope map.
     */
    override fun endFromJs(streamId: String, end: AnyMap) {
        BridgeKitNative.delegate.endFromJs(streamId, AnyMapCodec.fromAnyMap(end))
    }
}
