package io.github.malopezr7.bridgekit.runtime

/**
 * Marker annotation: types referenced by generated code are frozen at this API version.
 * An incompatible AAR bump (removing or changing a @BridgeKitGeneratedApiV1-annotated type)
 * causes a compile error in consuming repos, surfacing the break at build time.
 */
@MustBeDocumented
@Retention(AnnotationRetention.BINARY)
@Target(
    AnnotationTarget.CLASS,
    AnnotationTarget.FUNCTION,
    AnnotationTarget.PROPERTY,
    AnnotationTarget.CONSTRUCTOR,
    AnnotationTarget.VALUE_PARAMETER,
)
annotation class BridgeKitGeneratedApiV1

/**
 * Base class for generated contract definition objects.
 *
 * [P] — provider interface (native side implementation).
 * [C] — client/consumer interface (typed proxy returned to consumers).
 *
 * Generated code extends this as a Kotlin object:
 *   object ConnectHostContract : BridgeContractDefinition<ConnectHost, ConnectHostClient>(...)
 *
 * @param id Stable reverse-DNS contract identifier (e.g. "connect.host").
 * @param contractHash FNV-1a hash of the normalized contract descriptor. Used for drift detection.
 * @param memberHashes Per-member hashes keyed "methods.name", "streams.name", "state.name".
 */
@BridgeKitGeneratedApiV1
abstract class BridgeContractDefinition<P : Any, C : Any>(
    val id: String,
    val contractHash: String,
    val memberHashes: Map<String, String>,
) {
    /**
     * Wrap a provider [impl] in an [InboundContractAdapter] that routes untyped engine calls
     * to the typed provider methods.
     */
    abstract fun inbound(impl: P): InboundContractAdapter

    /**
     * Build a typed consumer proxy backed by [caller].
     * The engine injects an OutboundCaller that routes to JS through the wire protocol.
     */
    abstract fun outbound(caller: OutboundCaller): C
}
