package com.bridgekit

import com.bridgekit.core.*
import com.bridgekit.runtime.BridgeValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Tests for state store: seed, observe, unobserve, NOT_PROVIDER guard.
 */
class StateTest {

    private lateinit var stateStore: StateStore
    private lateinit var router: Router

    @Before
    fun setup() {
        stateStore = StateStore()
        router = Router(stateStore, ParkBuffer(), readinessTimeoutMs = 200, callTimeoutMs = 500)
    }

    // ---- seed / read -----------------------------------------------------------

    @Test
    fun `seedNativeState seeds Available value`() {
        stateStore.seedNativeState("c1", Scope.Global, "key", "hello")
        val v = stateStore.read("c1", Scope.Global, "key", null)
        assertTrue(v is BridgeValue.Available)
        assertEquals("hello", (v as BridgeValue.Available).value)
    }

    @Test
    fun `read returns Initial when no state seeded`() {
        val v = stateStore.read("c1", Scope.Global, "missing", "default")
        assertTrue(v is BridgeValue.Initial)
        assertEquals("default", (v as BridgeValue.Initial).value)
    }

    @Test
    fun `markUnprovided transitions to Unprovided`() {
        stateStore.seedNativeState("c1", Scope.Global, "key", "hello")
        stateStore.markUnprovided("c1", Scope.Global)
        val v = stateStore.read("c1", Scope.Global, "key", null)
        assertTrue(v is BridgeValue.Unprovided)
        assertEquals("hello", (v as BridgeValue.Unprovided).lastKnown)
    }

    // ---- observe / unobserve ---------------------------------------------------

    @Test
    fun `observe fires callback on value change`() {
        stateStore.seedNativeState("c1", Scope.Global, "key", "a")
        var received: Any? = null
        stateStore.observe("c1", Scope.Global, "key", epoch = 1) { map ->
            received = map["v"]
        }
        stateStore.setNativeValue("c1", Scope.Global, "key", "b")
        assertEquals("b", received)
    }

    @Test
    fun `observe only fires for matching contract state key and scope`() {
        val received = mutableListOf<Any?>()
        stateStore.observe("counter.contract", Scope.Global, "counter", epoch = 1) { map ->
            received.add(map["v"])
        }

        stateStore.setNativeValue("reverse.contract", Scope.Global, "jsStatus", "js-ready")
        stateStore.writeFromJs(
            "local.contract",
            Scope.Global,
            "mood",
            "focused",
            nativeOwnsBinding = false,
        )
        stateStore.setNativeValue("counter.contract", Scope.Feature("other"), "counter", 99)

        assertTrue(received.isEmpty())

        stateStore.setNativeValue("counter.contract", Scope.Global, "counter", 1)

        assertEquals(listOf(1), received)
    }

    @Test
    fun `unobserve stops callbacks`() {
        stateStore.seedNativeState("c1", Scope.Global, "key", "a")
        var callCount = 0
        val obsId = stateStore.observe("c1", Scope.Global, "key", epoch = 1) { callCount++ }
        stateStore.setNativeValue("c1", Scope.Global, "key", "b")
        assertEquals(1, callCount)
        stateStore.unobserve(obsId)
        stateStore.setNativeValue("c1", Scope.Global, "key", "c")
        assertEquals(1, callCount) // no additional calls
    }

    // ---- NOT_PROVIDER guard ---------------------------------------------------

    @Test
    fun `stateWrite returns NOT_PROVIDER when native owns binding`() {
        val result = stateStore.writeFromJs("c1", Scope.Global, "key", "value", nativeOwnsBinding = true)
        assertEquals(false, result["ok"])
        assertEquals("NOT_PROVIDER", result["code"])
    }

    @Test
    fun `stateWrite succeeds for JS-provided contracts`() {
        val result = stateStore.writeFromJs("js.contract", Scope.Global, "counter", 10, nativeOwnsBinding = false)
        assertEquals(true, result["ok"])
        val v = stateStore.read("js.contract", Scope.Global, "counter", null)
        assertTrue(v is BridgeValue.Available)
        assertEquals(10, (v as BridgeValue.Available).value)
    }

    // ---- router-level stateWrite -------------------------------------------

    @Test
    fun `router stateWrite rejects for native-provided binding`() {
        val defn = stubDefinition("native.contract")
        val adapter = StateCapturingAdapter("myKey", "init")
        val entry = makeEntry(defn, Scope.Global, adapter)
        router.registerBinding(entry)

        val env = mapOf(
            "contractId" to "native.contract",
            "member" to "myKey",
            "scope" to mapOf("kind" to "global"),
            "payload" to mapOf("v" to "newValue"),
        )
        val result = router.stateWrite(env)
        assertEquals(false, result["ok"])
        assertEquals("NOT_PROVIDER", result["code"])
    }

    @Test
    fun `router stateRead returns current value`() {
        stateStore.seedNativeState("c1", Scope.Global, "key", "hello")
        val env = mapOf(
            "contractId" to "c1",
            "member" to "key",
            "scope" to mapOf("kind" to "global"),
        )
        val result = router.stateRead(env)
        assertEquals(true, result["ok"])
        @Suppress("UNCHECKED_CAST")
        val wrapped = result["value"] as? Map<String, Any?>
        assertEquals("hello", wrapped?.get("v"))
    }

    // ---- W2-3: Replacing grace window -----------------------------------------

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `W2-3 markJsContractsUnprovided transitions to Replacing first, not Unprovided immediately`() = runTest {
        val testScope = TestScope(StandardTestDispatcher(testScheduler))
        val store = StateStore(replacingGraceMs = 250L, graceScope = testScope)

        store.writeFromJs("js.c", Scope.Global, "count", 10, nativeOwnsBinding = false)
        val v0 = store.read("js.c", Scope.Global, "count", null)
        assertTrue("should be Available before grace", v0 is BridgeValue.Available)

        // Trigger epoch swap — should transition to Replacing immediately
        store.markJsContractsUnprovided(setOf("js.c"))

        val v1 = store.read("js.c", Scope.Global, "count", null)
        assertTrue("should be Replacing within grace window, got $v1", v1 is BridgeValue.Replacing)
        assertEquals(10, (v1 as BridgeValue.Replacing).lastKnown)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `W2-3 grace window expires to Unprovided after replacingGraceMs`() = runTest {
        val testScope = TestScope(StandardTestDispatcher(testScheduler))
        val store = StateStore(replacingGraceMs = 250L, graceScope = testScope)

        store.writeFromJs("js.c", Scope.Global, "count", 42, nativeOwnsBinding = false)
        store.markJsContractsUnprovided(setOf("js.c"))

        val vDuring = store.read("js.c", Scope.Global, "count", null)
        assertTrue("should still be Replacing during grace window", vDuring is BridgeValue.Replacing)

        // Advance virtual time past the grace window
        testScope.advanceTimeBy(300L)

        val vAfter = store.read("js.c", Scope.Global, "count", null)
        assertTrue("should be Unprovided after grace window expires, got $vAfter", vAfter is BridgeValue.Unprovided)
        assertEquals(42, (vAfter as BridgeValue.Unprovided).lastKnown)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `W2-3 re-provision during grace window cancels timer and stays Available`() = runTest {
        val testScope = TestScope(StandardTestDispatcher(testScheduler))
        val store = StateStore(replacingGraceMs = 250L, graceScope = testScope)

        store.writeFromJs("js.c", Scope.Global, "count", 5, nativeOwnsBinding = false)
        store.markJsContractsUnprovided(setOf("js.c"))

        val vReplacing = store.read("js.c", Scope.Global, "count", null)
        assertTrue("should be Replacing", vReplacing is BridgeValue.Replacing)

        // Re-provide before timer fires — simulates fast OTA swap
        store.writeFromJs("js.c", Scope.Global, "count", 99, nativeOwnsBinding = false)

        // Advance past grace window — timer should have been cancelled, no flip to Unprovided
        testScope.advanceTimeBy(300L)

        val vAfter = store.read("js.c", Scope.Global, "count", null)
        assertTrue("should remain Available after re-provision, got $vAfter", vAfter is BridgeValue.Available)
        assertEquals(99, (vAfter as BridgeValue.Available).value)
    }

    // ---- helpers ---------------------------------------------------------------

    private fun stubDefinition(id: String) = object : com.bridgekit.runtime.BridgeContractDefinition<Any, Any>(
        id = id, contractHash = "abc", memberHashes = emptyMap(),
    ) {
        override fun inbound(impl: Any) = StateCapturingAdapter("myKey", "init")
        override fun outbound(caller: com.bridgekit.runtime.OutboundCaller): Any = object {}
    }

    private fun makeEntry(
        defn: com.bridgekit.runtime.BridgeContractDefinition<*, *>,
        scope: Scope,
        adapter: com.bridgekit.runtime.InboundContractAdapter,
    ): BindingEntry {
        val bindingScope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default
        )
        return BindingEntry(defn, scope, adapter, bindingScope)
    }
}
