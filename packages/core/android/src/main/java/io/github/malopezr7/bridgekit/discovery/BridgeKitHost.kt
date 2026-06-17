package io.github.malopezr7.bridgekit.discovery

import android.content.Context

/**
 * Host context passed to each [BridgeKitModule] during ServiceLoader discovery.
 *
 * Provides the application context and a DI locator so module factories can obtain
 * their dependencies without hard-coding a specific DI container.
 *
 * The host application installs its locator once during host init (same place
 * ReactManager dependencies are set today).
 *
 * Usage in a module:
 * ```kotlin
 * class ConnectBridgeModule : BridgeKitModule {
 *     override fun register(bridgekit: BridgeKit, host: BridgeKitHost) {
 *         bridgekit.provide(SegmentsContract) {
 *             SegmentsProvider(host.locate<SegmentsRepository>())
 *         }
 *     }
 * }
 * ```
 */
class BridgeKitHost(
    val applicationContext: Context?,
    @PublishedApi internal val locator: (Class<*>) -> Any?,
) {
    /**
     * Locate a dependency of type [T] via the host-installed DI locator.
     * Throws [IllegalStateException] if the dependency is not found.
     */
    inline fun <reified T> locate(): T {
        val instance = locator(T::class.java)
            ?: throw IllegalStateException(
                "BridgeKitHost: no dependency registered for ${T::class.java.name}. " +
                    "Ensure the host has registered this type in its locator.",
            )
        @Suppress("UNCHECKED_CAST")
        return instance as T
    }
}
