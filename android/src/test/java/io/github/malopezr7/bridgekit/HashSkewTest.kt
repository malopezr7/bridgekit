package io.github.malopezr7.bridgekit

import io.github.malopezr7.bridgekit.core.BindingEntry
import io.github.malopezr7.bridgekit.core.ParkBuffer
import io.github.malopezr7.bridgekit.core.Router
import io.github.malopezr7.bridgekit.core.Scope
import io.github.malopezr7.bridgekit.core.StateStore
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * W1-4: wire hash exchange + INCOMPATIBLE_CONTRACT skew detection (design Decision 2).
 *
 * The caller's contractHash rides every call envelope. When a native binding exists,
 * the Router compares its generated contractHash against the envelope hash.
 *
 * Three-stage rollout: the enforcement is gated behind `strictHashCheck` (default
 * false = observe mode) so the live demo never hard-breaks before device verification.
 * These tests drive the enforce path explicitly (strictHashCheck = true) to prove the
 * INCOMPATIBLE_CONTRACT path exists and is correct, and prove observe mode never rejects.
 */
class HashSkewTest {

    private fun newRouter(strict: Boolean): Router =
        Router(
            stateStore = StateStore(),
            parkBuffer = ParkBuffer(),
            readinessTimeoutMs = 200,
            callTimeoutMs = 1000,
            strictHashCheck = strict,
        )

    private fun stubDefinition(id: String, hash: String) =
        object : io.github.malopezr7.bridgekit.runtime.BridgeContractDefinition<Any, Any>(
            id = id,
            contractHash = hash,
            memberHashes = emptyMap(),
        ) {
            override fun inbound(impl: Any) = CapturingAdapter()
            override fun outbound(caller: io.github.malopezr7.bridgekit.runtime.OutboundCaller): Any = object {}
        }

    private fun makeEntry(id: String, hash: String, adapter: CapturingAdapter): BindingEntry {
        val bindingScope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default,
        )
        return BindingEntry(stubDefinition(id, hash), Scope.Global, adapter, bindingScope)
    }

    private fun invokeBlocking(router: Router, env: Map<String, Any?>): Map<String, Any?> {
        var result: Map<String, Any?>? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        router.invoke(env) { r ->
            result = r
            latch.countDown()
        }
        latch.await(2, java.util.concurrent.TimeUnit.SECONDS)
        assertNotNull(result)
        return result!!
    }

    @Test
    fun `strict mode returns INCOMPATIBLE_CONTRACT on hash mismatch without dispatching`() = runTest {
        val router = newRouter(strict = true)
        val adapter = CapturingAdapter(suspendResult = "ok")
        router.registerBinding(makeEntry("hash.contract", "native-hash", adapter))

        val env = mapOf(
            "contractId" to "hash.contract",
            "member" to "doThing",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "c1",
            "epoch" to 1,
            "contractHash" to "js-hash-different",
        )
        val result = invokeBlocking(router, env)

        assertEquals(false, result["ok"])
        assertEquals("INCOMPATIBLE_CONTRACT", result["code"])
        // The provider MUST NOT be dispatched on skew.
        assertEquals(false, adapter.invokeCalled)
    }

    @Test
    fun `INCOMPATIBLE_CONTRACT error carries both hashes in details`() = runTest {
        val router = newRouter(strict = true)
        router.registerBinding(makeEntry("hash.contract", "native-hash", CapturingAdapter()))

        val env = mapOf(
            "contractId" to "hash.contract",
            "member" to "doThing",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "c1",
            "epoch" to 1,
            "contractHash" to "js-hash",
        )
        val result = invokeBlocking(router, env)

        @Suppress("UNCHECKED_CAST")
        val details = result["details"] as? Map<String, Any?>
        assertNotNull("INCOMPATIBLE_CONTRACT must carry details", details)
        assertEquals("js-hash", details!!["callerHash"])
        assertEquals("native-hash", details["receiverHash"])
    }

    @Test
    fun `matching hash dispatches normally in strict mode`() = runTest {
        val router = newRouter(strict = true)
        val adapter = CapturingAdapter(suspendResult = "ok")
        router.registerBinding(makeEntry("hash.contract", "same-hash", adapter))

        val env = mapOf(
            "contractId" to "hash.contract",
            "member" to "doThing",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "c1",
            "epoch" to 1,
            "contractHash" to "same-hash",
        )
        val result = invokeBlocking(router, env)

        assertEquals(true, result["ok"])
        assertEquals("ok", result["value"])
        assertEquals(true, adapter.invokeCalled)
    }

    @Test
    fun `observe mode (default) dispatches despite hash mismatch — demo stays alive`() = runTest {
        val router = newRouter(strict = false)
        val adapter = CapturingAdapter(suspendResult = "ok")
        router.registerBinding(makeEntry("hash.contract", "native-hash", adapter))

        val env = mapOf(
            "contractId" to "hash.contract",
            "member" to "doThing",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "c1",
            "epoch" to 1,
            "contractHash" to "totally-different",
        )
        val result = invokeBlocking(router, env)

        // Observe mode: NEVER reject. The call dispatches normally.
        assertEquals(true, result["ok"])
        assertEquals("ok", result["value"])
        assertEquals(true, adapter.invokeCalled)
    }
}
