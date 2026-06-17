package com.bridgekit.core

import com.bridgekit.runtime.BridgeContractDefinition

/**
 * Minimal public API surface of BridgeKit used by [com.bridgekit.discovery.BridgeKitModule].
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
