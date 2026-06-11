package io.github.malopezr7.bridgekit

import io.github.malopezr7.bridgekit.core.*
import io.github.malopezr7.bridgekit.discovery.BridgeKitHost
import io.github.malopezr7.bridgekit.discovery.BridgeKitModule
import io.github.malopezr7.bridgekit.runtime.BridgeContractDefinition
import io.github.malopezr7.bridgekit.runtime.InboundContractAdapter
import io.github.malopezr7.bridgekit.runtime.OutboundCaller
import org.junit.Assert.*
import org.junit.Test

/**
 * Tests for ServiceLoader discovery and main-thread guard.
 */
class DiscoveryTest {

    // ---- duplicate global provide error ----------------------------------------

    @Test(expected = IllegalStateException::class)
    fun `duplicate global provide during init throws IllegalStateException`() {
        val router = Router(StateStore(), ParkBuffer(), readinessTimeoutMs = 100, callTimeoutMs = 500)
        val bridgeKit = BridgeKit(router)
        val defn = DummyDefinition("dup.contract")

        val module1 = object : BridgeKitModule {
            override fun register(bk: BridgeKitApi, host: BridgeKitHost) {
                bk.provide(defn, Scope.Global) { DummyProvider() }
            }
        }
        val module2 = object : BridgeKitModule {
            override fun register(bk: BridgeKitApi, host: BridgeKitHost) {
                bk.provide(defn, Scope.Global) { DummyProvider() }
            }
        }

        // Use GuardedBridgeKit directly (same logic used in BridgeKit.initialize)
        val registeredIds = mutableMapOf<String, String>()
        val guard1 = GuardedBridgeKit(bridgeKit, registeredIds, "Module1")
        val guard2 = GuardedBridgeKit(bridgeKit, registeredIds, "Module2")
        module1.register(guard1, fakeHost())
        module2.register(guard2, fakeHost()) // should throw
    }

    // ---- single module registration --------------------------------------------

    @Test
    fun `single module can register a binding`() {
        val router = Router(StateStore(), ParkBuffer(), readinessTimeoutMs = 100, callTimeoutMs = 500)
        val bridgeKit = BridgeKit(router)
        val defn = DummyDefinition("single.contract")

        val module = object : BridgeKitModule {
            override fun register(bk: BridgeKitApi, host: BridgeKitHost) {
                bk.provide(defn, Scope.Global) { DummyProvider() }
            }
        }
        module.register(bridgeKit, fakeHost())

        assertTrue(bridgeKit.isProvided(defn, Scope.Global))
    }

    // ---- main thread guard test -----------------------------------------------

    @Test
    fun `OutboundCallerImpl throws on main thread invoke`() {
        val router = Router(StateStore(), ParkBuffer())
        val caller = OutboundCallerImpl(
            contractId = "test.c",
            scope = Scope.Global,
            router = router,
            mainThreadChecker = MainThreadChecker { true }, // fake main thread
        )

        var thrown: Exception? = null
        kotlinx.coroutines.runBlocking {
            try {
                caller.invoke("method", null)
            } catch (e: IllegalStateException) {
                thrown = e
            }
        }
        assertNotNull("Expected IllegalStateException from main thread guard", thrown)
        assertTrue(thrown!!.message!!.contains("main thread"))
    }

    // ---- helpers ---------------------------------------------------------------

    private fun fakeHost(): BridgeKitHost = BridgeKitHost(
        // Unit tests never call applicationContext — null is safe here (Context? is nullable).
        applicationContext = null,
        locator = { null },
    )
}

// ---- fakes -----------------------------------------------------------------

internal class DummyProvider

internal class DummyDefinition(id: String) : BridgeContractDefinition<DummyProvider, Any>(
    id = id, contractHash = "abc", memberHashes = emptyMap(),
) {
    override fun inbound(impl: DummyProvider): InboundContractAdapter = CapturingAdapter()
    override fun outbound(caller: OutboundCaller): Any = object {}
}
