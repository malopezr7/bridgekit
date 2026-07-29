package com.bridgekit.core

/**
 * Reason a binding was closed. Affects how in-flight calls are handled.
 *
 * NOTE: [Replacing] does NOT currently park in-flight invokes. A
 * `REPLACING_GRACE_MS = 1500L` constant used to be declared here and was never
 * read by anything — the documented parking behaviour does not exist on either
 * platform. Mirrored state DOES get a grace window
 * ([StateStore.replacingGraceMs], 250ms), which is implemented and tested; that
 * is a different mechanism. Tracked in KNOWN_ISSUES.md rather than advertised by
 * a dead constant.
 */
sealed class CloseReason {
    /**
     * Binding is being replaced. In-flight invokes are not parked today.
     */
    object Replacing : CloseReason()

    /**
     * Binding is permanently closed. All pending calls fail immediately with
     * CONTRACT_NOT_PROVIDED; all open streams are terminated.
     */
    object Final : CloseReason()
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
