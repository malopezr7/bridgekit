package io.github.malopezr7.bridgekit.runtime

/**
 * Availability wrapper for bridgekit state values and consume proxies.
 *
 * - [Available] — a live provider is present; value comes from the provider.
 * - [Initial] — no provider yet (or not yet connected); value is the DSL-declared initial.
 * - [Replacing] — provider is reconnecting; last known value is still accessible but marked
 *   stale. Transitions to [Available] if re-provision arrives, or to [Unprovided] after the
 *   grace window expires. Consumers should treat this as "stale" (W2-3).
 * - [Unprovided] — provider existed but was closed/disconnected; [lastKnown] carries the
 *   last observed value for graceful degradation.
 */
sealed class BridgeValue<out T> {
    data class Available<out T>(val value: T) : BridgeValue<T>()
    data class Initial<out T>(val value: T) : BridgeValue<T>()
    /**
     * Stale-but-accessible state during the replacing grace window.
     * [lastKnown] is the last value from the closing provider.
     */
    data class Replacing<out T>(val lastKnown: T?) : BridgeValue<T>()
    data class Unprovided<out T>(val lastKnown: T?) : BridgeValue<T>()

    /** Unwrap the value regardless of status, returning null for Unprovided with no lastKnown. */
    fun valueOrNull(): T? = when (this) {
        is Available -> value
        is Initial -> value
        is Replacing -> lastKnown
        is Unprovided -> lastKnown
    }
}
