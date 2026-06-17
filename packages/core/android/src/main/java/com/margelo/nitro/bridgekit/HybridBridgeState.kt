package com.margelo.nitro.bridgekit

import androidx.annotation.Keep
import com.bridgekit.runtime.BridgeKitNative
import com.bridgekit.codec.AnyMapCodec
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.core.AnyMap

/**
 * Nitro Hybrid implementation for BridgeState.
 * Delegates all operations to [BridgeKitNative.delegate].
 */
@DoNotStrip
@Keep
class HybridBridgeState : HybridBridgeStateSpec() {

    /**
     * Synchronous state read.
     * Returns a ResultEnvelope map — { ok: true, v: <encoded-value> } or error.
     */
    override fun read(env: AnyMap): AnyMap {
        val result = BridgeKitNative.delegate.stateRead(AnyMapCodec.fromAnyMap(env))
        return AnyMapCodec.toAnyMap(result)
    }

    /**
     * Subscribe to state changes. Returns an epoch-scoped obsId.
     * onChange receives { v: <encoded-value> }.
     */
    override fun observe(env: AnyMap, onChange: (value: AnyMap) -> Unit): String {
        return BridgeKitNative.delegate.stateObserve(
            env = AnyMapCodec.fromAnyMap(env),
            onChange = { valueMap -> onChange(AnyMapCodec.toAnyMap(valueMap)) },
        )
    }

    /** Cancel a state observation. No-op if obsId is unknown or stale. */
    override fun unobserve(obsId: String) {
        BridgeKitNative.delegate.stateUnobserve(obsId)
    }

    /**
     * Provider-side state write from JS.
     * Returns a ResultEnvelope map. The router rejects with NOT_PROVIDER if the
     * caller doesn't own the binding.
     */
    override fun write(env: AnyMap): AnyMap {
        val result = BridgeKitNative.delegate.stateWrite(AnyMapCodec.fromAnyMap(env))
        return AnyMapCodec.toAnyMap(result)
    }
}
