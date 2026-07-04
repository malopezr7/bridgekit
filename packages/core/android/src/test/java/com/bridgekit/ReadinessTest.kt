package com.bridgekit

import com.bridgekit.core.BindingEntry
import com.bridgekit.core.CloseReason
import com.bridgekit.core.ParkBuffer
import com.bridgekit.core.Router
import com.bridgekit.core.Scope
import com.bridgekit.core.StateStore
import com.bridgekit.runtime.BridgeContractDefinition
import com.bridgekit.runtime.InboundContractAdapter
import com.bridgekit.runtime.OutboundCaller
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ReadinessTest {

    private lateinit var router: Router
    private lateinit var jsDispatcher: StubJsDispatcher

    @Before
    fun setup() {
        router = Router(StateStore(), ParkBuffer(), readinessTimeoutMs = 200, callTimeoutMs = 500)
        jsDispatcher = StubJsDispatcher()
        router.connectDispatcher(emptyMap(), jsDispatcher.asCallbacks())
    }

    @Test
    fun `Scope-keyed native registry`() {
        router.stateWrite(provideEnv("scope.contract", Scope.Feature("catalog")))

        assertTrue(router.isProvided("scope.contract", Scope.Feature("catalog")))
        assertTrue(router.isProvided("scope.contract", Scope.Instance("catalog", "screen-1")))
        assertFalse(router.isProvided("scope.contract", Scope.Feature("checkout")))
        assertFalse(router.isProvided("scope.contract", Scope.Instance("checkout", "screen-2")))
    }

    @Test
    fun `Native awaitProvided falls back to global JS provider`() = runTest {
        router.stateWrite(provideEnv("global.contract", Scope.Global))

        val provided = router.awaitProvided(
            contractId = "global.contract",
            scope = Scope.Instance("catalog", "screen-1"),
            timeoutMs = 1,
        )

        assertTrue(provided)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `Android check-and-park is atomic`() = runTest {
        // The lock-held check+park in Router.awaitProvided is review-verified in Router.kt.
        // This regression pins the observable fallback-wake path: an instance waiter must
        // be woken by a later global provider instead of timing out.
        val waiter = async {
            router.awaitProvided(
                contractId = "atomic.contract",
                scope = Scope.Instance("catalog", "screen-1"),
                timeoutMs = 200,
            )
        }
        runCurrent()

        router.stateWrite(provideEnv("atomic.contract", Scope.Global))
        runCurrent()

        assertTrue(waiter.await())
    }

    @Test
    fun `Native readiness deltas carry strictly increasing seq`() {
        val first = bindingEntry("seq.contract", Scope.Global)
        router.registerBinding(first)
        first.close(CloseReason.Final)
        router.removeBinding(first)

        val second = bindingEntry("seq.contract", Scope.Feature("catalog"))
        router.registerBinding(second)

        val deltas = jsDispatcher.stateWrites.toList()
        assertEquals(3, deltas.size)
        assertEquals(listOf("provide", "unprovide", "provide"), deltas.map { it["op"] })
        val seqs = deltas.map { delta ->
            val seq = delta["seq"] as? Number
            assertTrue("readiness delta must contain seq", seq != null)
            seq!!.toLong()
        }
        assertTrue(seqs.zipWithNext().all { (left, right) -> right > left })
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `Native final fails immediately without grace parking`() = runTest {
        val controlledRouter = Router(
            StateStore(),
            ParkBuffer(),
            readinessTimeoutMs = 200,
            callTimeoutMs = 500,
            engineScope = this,
        )
        controlledRouter.connectDispatcher(emptyMap(), jsDispatcher.asCallbacks())
        val entry = bindingEntry("final.contract", Scope.Global)
        controlledRouter.registerBinding(entry)

        entry.close(CloseReason.Final)
        controlledRouter.removeBinding(entry)

        val completed = CompletableDeferred<Map<String, Any?>>()
        controlledRouter.invoke(mapOf(
            "contractId" to "final.contract",
            "member" to "ping",
            "scope" to scopeEnv(Scope.Global),
        )) { result -> completed.complete(result) }
        runCurrent()

        assertTrue("Final close must fail without parking for the grace window", completed.isCompleted)
        val result = completed.await()
        assertEquals(false, result["ok"])
        assertEquals("CONTRACT_NOT_PROVIDED", result["code"])
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `Native final close does not wake parked waiters toward a dead provider`() = runTest {
        val waiter = async {
            router.awaitProvided(
                contractId = "dead.contract",
                scope = Scope.Global,
                timeoutMs = 200,
            )
        }
        runCurrent()

        val deadEntry = bindingEntry("dead.contract", Scope.Global)
        deadEntry.close(CloseReason.Final)
        router.removeBinding(deadEntry)
        runCurrent()

        assertFalse("Final close must not wake parked waiters toward a dead provider", waiter.isCompleted)
        advanceTimeBy(200)
        runCurrent()
        assertFalse(waiter.await())
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `Final close that lost removal race does not poison replacement`() = runTest {
        val staleEntry = bindingEntry("replacement.contract", Scope.Global)
        router.registerBinding(staleEntry)
        staleEntry.close(CloseReason.Final)

        val replacement = bindingEntry("replacement.contract", Scope.Global)
        router.registerBinding(replacement)
        router.removeBinding(staleEntry)

        replacement.close(CloseReason.Replacing)
        router.removeBinding(replacement)

        val waiter = async {
            router.awaitProvided(
                contractId = "replacement.contract",
                scope = Scope.Global,
                timeoutMs = 200,
            )
        }
        runCurrent()

        assertFalse(
            "A stale Final close with removed=false must not make later waits fail fast",
            waiter.isCompleted,
        )
        advanceTimeBy(200)
        runCurrent()
        assertFalse(waiter.await())
    }

    private fun provideEnv(contractId: String, scope: Scope): Map<String, Any?> = mapOf(
        "op" to "provide",
        "contractId" to contractId,
        "scope" to scopeEnv(scope),
        "epoch" to router.currentEpoch(),
    )

    private fun scopeEnv(scope: Scope): Map<String, Any?> = Router.scopeToEnvMap(scope)

    private fun bindingEntry(contractId: String, scope: Scope): BindingEntry = BindingEntry(
        definition = TestContractDefinition(contractId),
        scope = scope,
        adapter = TestInboundAdapter(),
        bindingScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    )

    private class TestContractDefinition(id: String) : BridgeContractDefinition<Any, Any>(
        id = id,
        contractHash = "test-hash",
        memberHashes = emptyMap(),
    ) {
        override fun inbound(impl: Any): InboundContractAdapter = TestInboundAdapter()
        override fun outbound(caller: OutboundCaller): Any = Any()
    }

    private class TestInboundAdapter : InboundContractAdapter {
        override val stateInitials: Map<String, Any?> = emptyMap()
        override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? = "ok"
        override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = "ok"
        override fun openStream(member: String, payload: Map<String, Any?>?): Flow<Any?> = emptyFlow()
        override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
    }
}
