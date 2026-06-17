package io.github.malopezr7.bridgekit.core

import io.github.malopezr7.bridgekit.runtime.BridgeContractDefinition

/**
 * Minimal public API surface of BridgeKit used by [io.github.malopezr7.bridgekit.discovery.BridgeKitModule].
 * Allows the ServiceLoader discovery layer to inject a guarded wrapper without subclassing
 * the concrete [BridgeKit] class.
 */
interface BridgeKitApi {
    fun <P : Any, C : Any> provide(
        definition: BridgeContractDefinition<P, C>,
        scope: Scope = Scope.Global,
        eager: Boolean = false,
        factory: () -> P,
    ): Binding

    suspend fun <P : Any, C : Any> consume(
        definition: BridgeContractDefinition<P, C>,
        scope: Scope = Scope.Global,
    ): C

    fun <P : Any, C : Any> isProvided(
        definition: BridgeContractDefinition<P, C>,
        scope: Scope = Scope.Global,
    ): Boolean
}
