package io.github.malopezr7.bridgekit.core

/**
 * Reason a binding was closed. Affects how in-flight calls are handled.
 */
sealed class CloseReason {
    /**
     * Binding is being replaced. The router holds in-flight calls for a grace window
     * ([REPLACING_GRACE_MS]) before failing with CONTRACT_NOT_PROVIDED.
     */
    object Replacing : CloseReason()

    /**
     * Binding is permanently closed. All pending calls fail immediately with
     * CONTRACT_NOT_PROVIDED; all open streams are terminated.
     */
    object Final : CloseReason()

    companion object {
        const val REPLACING_GRACE_MS = 1500L
    }
}

/**
 * Handle to a live provider binding returned from [BridgeKit.provide].
 * Calling [close] de-registers the provider and terminates its streams and state flows.
 */
interface Binding {
    val contractId: String
    val scope: Scope
    val isLive: Boolean

    /**
     * Close this binding with the given [reason].
     *
     * [CloseReason.Replacing] — engine holds in-flight calls for a short grace window
     * so a hot-swap provide() is seamless from the consumer side.
     *
     * [CloseReason.Final] — immediate fail of all pending ops.
     *
     * No-op if the binding has already been superseded or closed.
     */
    fun close(reason: CloseReason = CloseReason.Final)
}
