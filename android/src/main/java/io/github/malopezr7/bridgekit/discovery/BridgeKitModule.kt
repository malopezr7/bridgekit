package io.github.malopezr7.bridgekit.discovery

import io.github.malopezr7.bridgekit.core.BridgeKit
import io.github.malopezr7.bridgekit.core.BridgeKitApi

/**
 * ServiceLoader service interface for global-scope BridgeKit modules.
 *
 * Implementations are discovered via java.util.ServiceLoader at [BridgeKit.initialize] time.
 * Each module synchronously registers its contracts into the provided [BridgeKitApi] instance.
 *
 * Requirements:
 *  - Must have a public zero-arg constructor (ServiceLoader requirement).
 *  - Must NOT block — factory resolution is lazy by default.
 *  - R8/ProGuard rules in consumer-rules.pro keep implementations.
 *
 * Example:
 * ```kotlin
 * class ConnectBridgeModule : BridgeKitModule {
 *     override fun register(bridgekit: BridgeKitApi, host: BridgeKitHost) {
 *         bridgekit.provide(ConnectHostContract, Scope.Global) {
 *             ConnectHostProvider(host.locate())
 *         }
 *     }
 * }
 * ```
 *
 * Register by adding a file at:
 *   META-INF/services/io.github.malopezr7.bridgekit.discovery.BridgeKitModule
 * containing the fully-qualified implementation class name.
 */
interface BridgeKitModule {
    fun register(bridgekit: BridgeKitApi, host: BridgeKitHost)
}
