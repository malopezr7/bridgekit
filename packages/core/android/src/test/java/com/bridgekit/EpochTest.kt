package com.bridgekit

import com.bridgekit.core.*
import com.bridgekit.runtime.JsDispatcherCallbacks
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Tests for epoch swap semantics:
 * - connectDispatcher increments epoch
 * - prior-epoch stream pump jobs are cancelled
 * - JS-provided contracts are marked Unprovided on epoch swap
 * - Parked interests are failed on epoch swap (re-park semantics)
 */
class EpochTest {

    private lateinit var router: Router

    @Before
    fun setup() {
        router = Router(
            stateStore = StateStore(),
            parkBuffer = ParkBuffer(),
            readinessTimeoutMs = 200,
            callTimeoutMs = 1000,
        )
    }

    @Test
    fun `connectDispatcher increments epoch`() {
        assertEquals(0L, router.currentEpoch())
        router.connectDispatcher(emptyMap(), fakeCallbacks())
        assertEquals(1L, router.currentEpoch())
        router.connectDispatcher(emptyMap(), fakeCallbacks())
        assertEquals(2L, router.currentEpoch())
    }

    @Test
    fun `connectDispatcher returns epoch in result`() {
        val result = router.connectDispatcher(emptyMap(), fakeCallbacks())
        assertEquals(1L, (result["epoch"] as Number).toLong())
    }

    @Test
    fun `connectDispatcher returns state snapshot of native-provided state`() {
        // Provide a native contract with state
        val defn = stubDefinitionWithState("test.contract", "myKey", initial = "hello")
        val entry = makeEntry(defn, Scope.Global, StateCapturingAdapter("myKey", "hello"))
        router.registerBinding(entry)

        val result = router.connectDispatcher(emptyMap(), fakeCallbacks())
        @Suppress("UNCHECKED_CAST")
        val snapshot = result["snapshot"] as? List<Map<String, Any?>>
        assertNotNull(snapshot)
        assertTrue(snapshot!!.isNotEmpty())
        val first = snapshot.first()
        assertEquals("test.contract", first["contractId"])
        assertEquals("myKey", first["key"])
    }

    @Test
    fun `epoch swap transitions JS-provided state to Replacing grace window (W2-3)`() {
        val stateStore = StateStore()
        val router = Router(stateStore, ParkBuffer(), readinessTimeoutMs = 100, callTimeoutMs = 500)

        // Seed a JS-provided state
        stateStore.writeFromJs("js.contract", Scope.Global, "counter", 5, nativeOwnsBinding = false)

        // Check it's available
        val before = stateStore.read("js.contract", Scope.Global, "counter", null)
        assertTrue(before is com.bridgekit.runtime.BridgeValue.Available)

        // Simulate epoch swap by connecting a new dispatcher.
        // W2-3: state now transitions to Replacing (stale, grace window) rather than
        // jumping directly to Unprovided. This prevents flapping consumers during fast
        // reconnects. The timer will fire after replacingGraceMs to complete the transition.
        router.markJsProvided("js.contract")
        router.connectDispatcher(emptyMap(), fakeCallbacks())

        val after = stateStore.read("js.contract", Scope.Global, "counter", null)
        // Immediately after epoch swap: Replacing (stale-but-accessible), NOT Unprovided.
        assertTrue(
            "Expected Replacing (grace window) immediately after epoch swap, got $after",
            after is com.bridgekit.runtime.BridgeValue.Replacing,
        )
        assertEquals("last known value preserved during grace", 5, (after as com.bridgekit.runtime.BridgeValue.Replacing).lastKnown)
    }

    @Test
    fun `dump includes epoch info`() {
        router.connectDispatcher(emptyMap(), fakeCallbacks())
        val dump = router.dump()
        assertTrue("dump should contain epoch=1", dump.contains("epoch=1"))
    }

    // ---- helpers ---------------------------------------------------------------

    private fun fakeCallbacks() = JsDispatcherCallbacks(
        onInvoke = { _, completion -> completion(mapOf("ok" to true), null) },
        onStreamOpen = {},
        onStreamClose = {},
        onStateWrite = {},
    )

    private fun stubDefinitionWithState(id: String, stateKey: String, initial: Any?) =
        object : com.bridgekit.runtime.BridgeContractDefinition<Any, Any>(
            id = id, contractHash = "abc", memberHashes = emptyMap(),
        ) {
            override fun inbound(impl: Any) = StateCapturingAdapter(stateKey, initial)
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

// ---- StateCapturingAdapter -------------------------------------------------------

internal class StateCapturingAdapter(
    private val stateKey: String,
    private val initial: Any?,
) : com.bridgekit.runtime.InboundContractAdapter {
    private val _stateFlow = kotlinx.coroutines.flow.MutableStateFlow<Any?>(initial)

    override val stateInitials: Map<String, Any?> = mapOf(stateKey to initial)

    override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? = null
    override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = null
    override fun openStream(member: String, payload: Map<String, Any?>?): kotlinx.coroutines.flow.Flow<Any?> =
        kotlinx.coroutines.flow.emptyFlow()

    @Suppress("UNCHECKED_CAST")
    override fun stateFlows(): Map<String, kotlinx.coroutines.flow.StateFlow<Any?>> =
        mapOf(stateKey to _stateFlow as kotlinx.coroutines.flow.StateFlow<Any?>)
}
