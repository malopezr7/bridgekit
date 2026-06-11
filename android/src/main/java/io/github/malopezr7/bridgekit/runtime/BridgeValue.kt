package io.github.malopezr7.bridgekit.runtime

/**
 * Availability wrapper for bridgekit state values and consume proxies.
 *
 * - [Available] — a live provider is present; value comes from the provider.
 * - [Initial] — no provider yet (or not yet connected); value is the DSL-declared initial.
 * - [Unprovided] — provider existed but was closed/disconnected; [lastKnown] carries the
 *   last observed value for graceful degradation.
 */
sealed class BridgeValue<out T> {
    data class Available<out T>(val value: T) : BridgeValue<T>()
    data class Initial<out T>(val value: T) : BridgeValue<T>()
    data class Unprovided<out T>(val lastKnown: T?) : BridgeValue<T>()

    /** Unwrap the value regardless of status, returning null for Unprovided with no lastKnown. */
    fun valueOrNull(): T? = when (this) {
        is Available -> value
        is Initial -> value
        is Unprovided -> lastKnown
    }
}
