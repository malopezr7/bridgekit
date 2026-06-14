package io.github.malopezr7.bridgekit

import io.github.malopezr7.bridgekit.core.*
import io.github.malopezr7.bridgekit.runtime.BridgeKitNativeDelegate
import io.github.malopezr7.bridgekit.runtime.JsDispatcherCallbacks
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Tests for scope resolution, park-then-provide flow, readiness timeout,
 * and inbound adapter round trip.
 */
class RouterBasicTest {

    private lateinit var stateStore: StateStore
    private lateinit var parkBuffer: ParkBuffer
    private lateinit var router: Router

    @Before
    fun setup() {
        stateStore = StateStore()
        parkBuffer = ParkBuffer()
        router = Router(
            stateStore = stateStore,
            parkBuffer = parkBuffer,
            readinessTimeoutMs = 200,
            callTimeoutMs = 1000,
        )
    }

    // ---- scope resolution order ------------------------------------------------

    @Test
    fun `resolveBinding returns instance scope first`() {
        val defn = stubDefinition("test.contract")
        val globalEntry = makeEntry(defn, Scope.Global)
        val instanceEntry = makeEntry(defn, Scope.Instance("F", "t1"))
        router.registerBinding(globalEntry)
        router.registerBinding(instanceEntry)

        val resolved = router.resolveBinding("test.contract", Scope.Instance("F", "t1"))
        assertSame(instanceEntry, resolved)
    }

    @Test
    fun `resolveBinding falls back to feature scope`() {
        val defn = stubDefinition("test.contract")
        val featureEntry = makeEntry(defn, Scope.Feature("F"))
        router.registerBinding(featureEntry)

        // Query with instance scope — should fall through to feature
        val resolved = router.resolveBinding("test.contract", Scope.Instance("F", "t1"))
        assertSame(featureEntry, resolved)
    }

    @Test
    fun `resolveBinding falls back to global scope`() {
        val defn = stubDefinition("test.contract")
        val globalEntry = makeEntry(defn, Scope.Global)
        router.registerBinding(globalEntry)

        val resolved = router.resolveBinding("test.contract", Scope.Instance("F", "t1"))
        assertSame(globalEntry, resolved)
    }

    @Test
    fun `resolveBinding returns null when not provided`() {
        assertNull(router.resolveBinding("missing.contract", Scope.Global))
    }

    // ---- park-then-provide -----------------------------------------------------

    @Test
    fun `park-then-provide flow resolves waiting op`() = runTest {
        val defn = stubDefinition("park.contract")
        var provided = false
        // Start a coroutine that waits for the contract
        val waitJob = launch {
            provided = router.awaitProvided("park.contract", Scope.Global, 500)
        }
        // Brief yield so the waiter parks
        delay(10)
        assertFalse(provided)

        // Now provide the contract
        val entry = makeEntry(defn, Scope.Global)
        router.registerBinding(entry)

        waitJob.join()
        assertTrue(provided)
    }

    // ---- readiness timeout → CONTRACT_NOT_PROVIDED ---------------------------

    @Test
    fun `invoke returns CONTRACT_NOT_PROVIDED after readiness timeout`() = runTest {
        val env = mapOf(
            "contractId" to "missing.contract",
            "member" to "doSomething",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "c1",
            "epoch" to 1,
        )
        var result: Map<String, Any?>? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        router.invoke(env) { r ->
            result = r
            latch.countDown()
        }
        latch.await(2, java.util.concurrent.TimeUnit.SECONDS)
        assertNotNull(result)
        assertEquals(false, result!!["ok"])
        assertEquals("CONTRACT_NOT_PROVIDED", result!!["code"])
    }

    // ---- inbound adapter invoke via router ------------------------------------

    @Test
    fun `invoke routes to adapter and returns ok envelope`() = runTest {
        val defn = stubDefinition("echo.contract")
        val adapter = CapturingAdapter(suspendResult = "hello")
        val entry = makeEntry(defn, Scope.Global, adapter)
        router.registerBinding(entry)

        val env = mapOf(
            "contractId" to "echo.contract",
            "member" to "doThing",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "c1",
            "epoch" to 1,
        )
        var result: Map<String, Any?>? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        router.invoke(env) { r ->
            result = r
            latch.countDown()
        }
        latch.await(2, java.util.concurrent.TimeUnit.SECONDS)
        assertNotNull(result)
        assertEquals(true, result!!["ok"])
        assertEquals("hello", result!!["value"])
        assertTrue(adapter.invokeCalled)
    }

    // ---- invokeSync ----------------------------------------------------------

    @Test
    fun `invokeSync routes to adapter`() {
        val defn = stubDefinition("sync.contract")
        val adapter = CapturingAdapter(syncResult = 42)
        val entry = makeEntry(defn, Scope.Global, adapter)
        router.registerBinding(entry)

        val env = mapOf(
            "contractId" to "sync.contract",
            "member" to "getValue",
            "scope" to mapOf("kind" to "global"),
        )
        val result = router.invokeSync(env)
        assertEquals(true, result["ok"])
        assertEquals(42, result["value"])
    }

    // ---- isProvided / awaitProvided ------------------------------------------

    @Test
    fun `isProvided returns true after provide`() {
        val defn = stubDefinition("test.x")
        router.registerBinding(makeEntry(defn, Scope.Global))
        assertTrue(router.isProvided("test.x", Scope.Global))
    }

    @Test
    fun `isProvided returns false before provide`() {
        assertFalse(router.isProvided("no.contract", Scope.Global))
    }

    // QW-5: isProvided must return true for JS-provided contracts after markJsProvided is called.
    // Before the fix, markJsProvided() only tracked the ID for epoch cleanup but isProvided()
    // only checked native bindings — so it always returned false for JS-provided contracts.
    @Test
    fun `QW-5 isProvided returns true after markJsProvided for global scope`() {
        // No native binding registered — JS is the provider.
        assertFalse(
            "isProvided should return false before markJsProvided",
            router.isProvided("js.provided.contract", Scope.Global)
        )

        router.markJsProvided("js.provided.contract")

        assertTrue(
            "isProvided should return true after markJsProvided",
            router.isProvided("js.provided.contract", Scope.Global)
        )
    }

    @Test
    fun `QW-5 isProvided returns false for different contract after markJsProvided`() {
        router.markJsProvided("js.contract.a")

        assertFalse(
            "isProvided should be false for contract B when only A was marked",
            router.isProvided("js.contract.b", Scope.Global)
        )
    }

    // ---- helpers ---------------------------------------------------------------

    private fun stubDefinition(id: String) = object : io.github.malopezr7.bridgekit.runtime.BridgeContractDefinition<Any, Any>(
        id = id, contractHash = "abc", memberHashes = emptyMap(),
    ) {
        override fun inbound(impl: Any) = CapturingAdapter()
        override fun outbound(caller: io.github.malopezr7.bridgekit.runtime.OutboundCaller): Any = object {}
    }

    private fun makeEntry(
        defn: io.github.malopezr7.bridgekit.runtime.BridgeContractDefinition<*, *>,
        scope: Scope,
        adapter: io.github.malopezr7.bridgekit.runtime.InboundContractAdapter = CapturingAdapter(),
    ): BindingEntry {
        val bindingScope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default
        )
        return BindingEntry(defn, scope, adapter, bindingScope)
    }
}

// ---- Test fakes ---------------------------------------------------------------

internal class CapturingAdapter(
    private val suspendResult: Any? = null,
    private val syncResult: Any? = null,
) : io.github.malopezr7.bridgekit.runtime.InboundContractAdapter {
    var invokeCalled = false
    var invokedMember: String? = null

    override val stateInitials: Map<String, Any?> = emptyMap()

    override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? {
        invokeCalled = true
        invokedMember = member
        return suspendResult
    }

    override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = syncResult

    override fun openStream(member: String, payload: Map<String, Any?>?): kotlinx.coroutines.flow.Flow<Any?> =
        emptyFlow()

    override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
}
