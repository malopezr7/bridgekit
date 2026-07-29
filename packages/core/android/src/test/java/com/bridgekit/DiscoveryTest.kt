package com.bridgekit

import com.bridgekit.core.*
import com.bridgekit.discovery.BridgeKitHost
import com.bridgekit.discovery.BridgeKitModule
import com.bridgekit.runtime.BridgeContractDefinition
import com.bridgekit.runtime.InboundContractAdapter
import com.bridgekit.runtime.OutboundCaller
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

    // ---- main thread -----------------------------------------------------------

    /**
     * This test used to assert the opposite, pinning RT-AND-09 in place: `invoke`
     * threw `IllegalStateException` whenever the caller was on the main thread.
     *
     * `invoke` is a suspend function, so running it on `Dispatchers.Main` yields
     * the thread rather than blocking it and cannot cause an ANR. The guard's only
     * real effect was to reject `lifecycleScope.launch { client.foo() }`, the
     * canonical Android call site. See MainThreadChecker for the full reasoning.
     *
     * The remaining behavioural coverage lives in MainThreadGuardTest.
     */
    @Test
    fun `OutboundCallerImpl does not reject invoke from the main thread`() {
        val router = Router(StateStore(), ParkBuffer(), readinessTimeoutMs = 50, callTimeoutMs = 50)
        val caller = OutboundCallerImpl(
            contractId = "test.c",
            scope = Scope.Global,
            router = router,
            mainThreadChecker = MainThreadChecker { true }, // fake main thread
            readinessTimeoutMs = 50,
            callTimeoutMs = 50,
        )

        var thrown: Throwable? = null
        kotlinx.coroutines.runBlocking {
            try {
                caller.invoke("method", null)
            } catch (e: Throwable) {
                thrown = e
            }
        }

        // No dispatcher is connected, so this still fails — but on readiness,
        // not on which thread the caller happened to be using.
        assertTrue(
            "invoke was rejected for running on the main thread: $thrown",
            thrown !is IllegalStateException,
        )
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
