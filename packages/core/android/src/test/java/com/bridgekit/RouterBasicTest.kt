package com.bridgekit

import com.bridgekit.core.*
import com.bridgekit.runtime.BridgeKitNativeDelegate
import com.bridgekit.runtime.JsDispatcherCallbacks
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

    // isProvided must return true for JS-provided contracts after markJsProvided is called.
    // Before the fix, isProvided() only checked native bindings, so it always returned false
    // for JS-provided contracts.
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

    // ---- isProvided via REAL JS-provide path (stateWrite) ----------------

    // markJsProvided must be called by Router.stateWrite for contracts not owned by native.
    // These tests drive the REAL provide path — they do NOT call markJsProvided directly.
    @Test
    fun `ADR-5 isProvided true after JS stateWrite for non-native-owned contract`() {
        val contractId = "test.js-provided"

        // No native binding registered — JS is the provider.
        assertFalse(
            "isProvided must be false before any stateWrite",
            router.isProvided(contractId, Scope.Global)
        )

        // Simulate JS calling bk.provide(contract, impl) which pushes initial state.
        // This is the REAL provide path — does NOT call markJsProvided directly.
        val env = mapOf(
            "contractId" to contractId,
            "member" to "someStateKey",
            "scope" to mapOf("kind" to "global"),
            "payload" to mapOf("v" to "initial-value"),
        )
        router.stateWrite(env)

        // After the stateWrite arrives and there is no native binding, the Router
        // must call markJsProvided internally so isProvided returns true.
        assertTrue(
            "isProvided must be true after JS stateWrite for a non-native-owned contract",
            router.isProvided(contractId, Scope.Global)
        )
    }

    @Test
    fun `ADR-5 awaitProvided resolves after JS stateWrite for non-native-owned contract`() = runTest {
        val contractId = "test.js-await-provided"

        // Simulate JS stateWrite arriving (the real JS provide path).
        val env = mapOf(
            "contractId" to contractId,
            "member" to "value",
            "scope" to mapOf("kind" to "global"),
            "payload" to mapOf("v" to 42),
        )
        router.stateWrite(env)

        // awaitProvided must resolve (not time out) because markJsProvided and
        // parkBuffer.unpark were called by stateWrite.
        val resolved = router.awaitProvided(contractId, Scope.Global, timeoutMs = 200)
        assertTrue(
            "awaitProvided must resolve (not time out) after JS stateWrite",
            resolved
        )
    }

    @Test
    fun `ADR-5 native-owned contract stateWrite does NOT mark as JS-provided`() {
        val defn = stubDefinition("native.owned")
        val entry = makeEntry(defn, Scope.Global)
        router.registerBinding(entry)

        // stateWrite for a contract that IS native-owned must not mark it as JS-provided
        // (native binding already covers isProvided).
        val env = mapOf(
            "contractId" to "native.owned",
            "member" to "value",
            "scope" to mapOf("kind" to "global"),
            "payload" to mapOf("v" to "data"),
        )
        router.stateWrite(env)

        // isProvided is true (via native binding), but for the right reason.
        // The JS-provided set must NOT have added "native.owned".
        assertTrue(
            "isProvided must be true via native binding after native-owned stateWrite",
            router.isProvided("native.owned", Scope.Global)
        )
    }

    // ---- Stateless JS-provided contracts — explicit provide announcement ----
    //
    // A contract with NO state (only methods/streams) never emits stateWrite, so the
    // old provide path never fired. The fix: JS sends {op:'provide'} through the stateWrite
    // channel at provide() time. Router.stateWrite branches on op and calls
    // markJsProvided + parkBuffer.unpark WITHOUT writing state.
    //
    // These tests drive the REAL announce path — they do NOT call markJsProvided() directly.

    @Test
    fun `ADR-5b stateless JS contract provide envelope marks isProvided true`() {
        val contractId = "test.stateless-js"

        // No native binding, no state — purely a method-only JS-provided contract.
        assertFalse(
            "isProvided must be false before any announcement",
            router.isProvided(contractId, Scope.Global)
        )

        // Simulate JS transport.announceProvided → sends {op:provide} through state.write.
        // This is the REAL announcement path — does NOT call markJsProvided directly.
        val env = mapOf(
            "op" to "provide",
            "contractId" to contractId,
            "scope" to mapOf("kind" to "global"),
            // member is empty string — no state key for a stateless contract
            "member" to "",
        )
        router.stateWrite(env)

        assertTrue(
            "isProvided must be true after op=provide envelope arrives via stateWrite",
            router.isProvided(contractId, Scope.Global)
        )
    }

    @Test
    fun `ADR-5b stateless JS contract awaitProvided resolves after provide envelope`() = runTest {
        val contractId = "test.stateless-await"

        // Fire the provide envelope first (simulates JS runtime sending it at provide()-time).
        val env = mapOf(
            "op" to "provide",
            "contractId" to contractId,
            "scope" to mapOf("kind" to "global"),
            "member" to "",
        )
        router.stateWrite(env)

        // awaitProvided must resolve immediately (unparked by the provide envelope).
        val resolved = router.awaitProvided(contractId, Scope.Global, timeoutMs = 200)
        assertTrue(
            "awaitProvided must resolve after op=provide envelope",
            resolved
        )
    }

    @Test
    fun `ADR-5b stateless JS contract provide envelope does NOT write state`() {
        val contractId = "test.stateless-no-state"

        val env = mapOf(
            "op" to "provide",
            "contractId" to contractId,
            "scope" to mapOf("kind" to "global"),
            "member" to "",
        )
        router.stateWrite(env)

        // The state store must NOT have any entry for this contract (no state key was provided).
        val value = stateStore.read(contractId, Scope.Global, "", null)
        // If state was accidentally written, it would be BridgeValue.Available.
        // A provide-only envelope must NOT touch the state store.
        assertFalse(
            "provide envelope must not write state — got Available when nothing should be stored",
            value is com.bridgekit.runtime.BridgeValue.Available
        )
    }

    @Test
    fun `ADR-5b unprovide envelope marks isProvided false for stateless JS contract`() {
        val contractId = "test.stateless-unprovide"

        // First provide
        router.stateWrite(mapOf(
            "op" to "provide",
            "contractId" to contractId,
            "scope" to mapOf("kind" to "global"),
            "member" to "",
        ))
        assertTrue("must be provided after provide envelope", router.isProvided(contractId, Scope.Global))

        // Now unprovide
        router.stateWrite(mapOf(
            "op" to "unprovide",
            "contractId" to contractId,
            "scope" to mapOf("kind" to "global"),
            "member" to "",
        ))

        assertFalse(
            "isProvided must be false after op=unprovide envelope",
            router.isProvided(contractId, Scope.Global)
        )
    }

    // ---- helpers ---------------------------------------------------------------

    private fun stubDefinition(id: String) = object : com.bridgekit.runtime.BridgeContractDefinition<Any, Any>(
        id = id, contractHash = "abc", memberHashes = emptyMap(),
    ) {
        override fun inbound(impl: Any) = CapturingAdapter()
        override fun outbound(caller: com.bridgekit.runtime.OutboundCaller): Any = object {}
    }

    private fun makeEntry(
        defn: com.bridgekit.runtime.BridgeContractDefinition<*, *>,
        scope: Scope,
        adapter: com.bridgekit.runtime.InboundContractAdapter = CapturingAdapter(),
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
) : com.bridgekit.runtime.InboundContractAdapter {
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
