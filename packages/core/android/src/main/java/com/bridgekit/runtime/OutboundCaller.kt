package com.bridgekit.runtime

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * Injected by the engine into the generated outbound proxy factory.
 *
 * Generated code calls these methods; the engine provides the implementation
 * that routes through the JS dispatcher with readiness-bounded waiting.
 *
 * Marker: [BridgeKitGeneratedApiV1] — generated code may reference this interface
 * by its frozen v1 shape. Do NOT add/remove methods without a new marker version.
 */
@BridgeKitGeneratedApiV1
interface OutboundCaller {

    /**
     * Async call into a JS-provided contract method.
     * Suspends until the dispatcher is ready and the contract is provided.
     * Returns the raw decoded result value (Any?).
     * Throws [com.bridgekit.core.BridgeKitException] on error.
     */
    suspend fun invoke(member: String, payload: Map<String, Any?>?): Any?

    /**
     * Synchronous call for querySync members.
     * Only valid for NATIVE-provided contracts (lock-free store reads).
     * Calling this toward a JS-provided contract throws UnsupportedOperationException.
     */
    fun invokeSync(member: String, payload: Map<String, Any?>?): Any?

    /**
     * Fire-and-forget call into a JS-provided contract method (Void marker).
     * Dispatches asynchronously off the calling thread; never blocks, never returns a
     * result. Errors are swallowed (fire-and-forget semantics).
     */
    fun fire(member: String, payload: Map<String, Any?>?)

    /**
     * Open a Flow for a JS-provided stream member.
     * Cancellation of the collecting coroutine signals teardown to the JS producer.
     */
    fun stream(member: String, payload: Map<String, Any?>?): Flow<Any?>

    /**
     * Return the StateFlow for a JS-provided state member.
     * Returns BridgeValue<Any?> wrapped values: Available, Initial, or Unprovided.
     */
    fun state(member: String): StateFlow<BridgeValue<Any?>>
}
