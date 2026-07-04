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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
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
    fun `Native final fails immediately`() = runTest {
        val entry = bindingEntry("final.contract", Scope.Global)
        router.registerBinding(entry)

        entry.close(CloseReason.Final)
        router.removeBinding(entry)

        val result = router.invokeSync(mapOf(
            "contractId" to "final.contract",
            "member" to "ping",
            "scope" to scopeEnv(Scope.Global),
        ))

        assertEquals(false, result["ok"])
        assertEquals("CONTRACT_NOT_PROVIDED", result["code"])
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
