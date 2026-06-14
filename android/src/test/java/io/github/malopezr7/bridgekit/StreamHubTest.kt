package io.github.malopezr7.bridgekit

import io.github.malopezr7.bridgekit.core.Scope
import io.github.malopezr7.bridgekit.core.StreamHub
import io.github.malopezr7.bridgekit.runtime.InboundContractAdapter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flow
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * W-2 (verify fix): StreamHub refcount and upstream-cancel tests.
 *
 * Tests the StreamHub.detach() mechanism directly — the Router-level openStream/
 * closeStream path cancels consumer jobs, but the upstream termination on
 * last-consumer-unsubscribe is a StreamHub contract tested here at the unit level.
 *
 * W-5 (verify fix): Late subscriber with latestOnly=true receives the last-emitted
 * value immediately on attach (SharedFlow replay=1 semantics).
 */
class StreamHubTest {

    private lateinit var engineScope: CoroutineScope
    private lateinit var hub: StreamHub

    @Before
    fun setup() {
        engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        hub = StreamHub(engineScope)
    }

    // ---- W-2: Last consumer unsubscribes → upstream provider stops ---------------

    /**
     * W-2: Two consumers share a non-completing upstream (MutableSharedFlow source).
     * When both call StreamHub.detach(), refcount reaches 0 and the upstream Job is
     * cancelled — proven by the finally-block in the provider flow firing.
     *
     * Uses CountDownLatch (not runTest) because engineScope runs on Dispatchers.Default
     * and is independent of the test coroutine scheduler.
     */
    @Test
    fun `W-2 two consumers both detaching cancels the upstream provider`() {
        val upstreamActiveLatch = CountDownLatch(1)
        val upstreamCancelledLatch = CountDownLatch(1)

        // Non-completing source — will only stop if the upstream Job is cancelled
        val source = MutableSharedFlow<Any?>(replay = 0)

        val adapter = object : InboundContractAdapter {
            override val stateInitials: Map<String, Any?> = emptyMap()
            override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? = null
            override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = null
            override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
            override fun openStream(member: String, payload: Map<String, Any?>?): Flow<Any?> =
                flow {
                    upstreamActiveLatch.countDown()
                    try {
                        source.collect { emit(it) }
                    } finally {
                        // finally fires when the coroutine collecting this flow is cancelled
                        upstreamCancelledLatch.countDown()
                    }
                }
        }

        val contractId = "hub.test"
        val member = "items"
        val scope = Scope.Global
        val paramsHash = 0L

        // Attach consumer 1 — starts the upstream
        hub.attach(
            contractId = contractId,
            member = member,
            scope = scope,
            paramsHash = paramsHash,
            adapter = adapter,
            payload = null,
            streamEpoch = 1L,
            streamId = "s1",
            onNext = {},
            onEnd = {},
        )

        // Attach consumer 2 (same key — joins the same hub entry, refcount = 2)
        hub.attach(
            contractId = contractId,
            member = member,
            scope = scope,
            paramsHash = paramsHash,
            adapter = adapter,
            payload = null,
            streamEpoch = 1L,
            streamId = "s2",
            onNext = {},
            onEnd = {},
        )

        // Wait for upstream to start collecting
        assertTrue(
            "Upstream must start collecting within 2s",
            upstreamActiveLatch.await(2, TimeUnit.SECONDS),
        )

        // Detach consumer 1 — refcount drops to 1; upstream must stay alive
        hub.detach(contractId, member, scope, paramsHash)
        Thread.sleep(100) // give cancellation a chance to propagate (shouldn't happen at refcount=1)
        assertTrue(
            "Upstream must NOT be cancelled after first detach (refcount = 1)",
            upstreamCancelledLatch.count == 1L,
        )

        // Detach consumer 2 — refcount drops to 0; upstream must be cancelled
        hub.detach(contractId, member, scope, paramsHash)

        assertTrue(
            "Upstream must be cancelled after both consumers detach (refcount = 0)",
            upstreamCancelledLatch.await(2, TimeUnit.SECONDS),
        )
    }

    // ---- W-5: Late subscriber with latestOnly=true receives last-emitted value ----

    /**
     * W-5: A late subscriber attaching to a latestOnly=true hub receives the last
     * value already emitted, without waiting for the next upstream emission.
     *
     * Validates the replay=1 path in StreamHub (replay = if (latestOnly || sticky) 1 else 0).
     * Uses a controlled MutableSharedFlow so the upstream does NOT complete before the late
     * subscriber attaches — making the assertion real, not an artifact of flow completion.
     */
    @Test
    fun `W-5 late subscriber with latestOnly=true receives last-emitted value on attach`() {
        val upstreamActiveLatch = CountDownLatch(1)
        val earlyItemLatch = CountDownLatch(1)
        val lateItemLatch = CountDownLatch(1)

        val earlyItems = mutableListOf<Map<String, Any?>>()
        val lateItems = mutableListOf<Map<String, Any?>>()

        // replay=0 on source so items are not cached at the source level;
        // replay=1 is on the StreamHub's MutableSharedFlow (entry.sharedFlow).
        val upstreamSource = MutableSharedFlow<Any?>(replay = 0, extraBufferCapacity = 8)

        val adapter = object : InboundContractAdapter {
            override val stateInitials: Map<String, Any?> = emptyMap()
            override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? = null
            override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = null
            override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
            override fun openStream(member: String, payload: Map<String, Any?>?): Flow<Any?> =
                flow {
                    upstreamActiveLatch.countDown() // signal that collection started
                    upstreamSource.collect { emit(it) }
                }
        }

        val contractId = "hub.replay.test"
        val member = "latestItems"
        val scope = Scope.Global
        val paramsHash = 0L

        // Attach early subscriber (latestOnly = true → MutableSharedFlow replay = 1)
        hub.attach(
            contractId = contractId,
            member = member,
            scope = scope,
            paramsHash = paramsHash,
            adapter = adapter,
            payload = null,
            streamEpoch = 1L,
            streamId = "early",
            latestOnly = true,
            onNext = { v ->
                earlyItems.add(v)
                earlyItemLatch.countDown()
            },
            onEnd = {},
        )

        // Wait for the upstream to start collecting so emit() will be received
        assertTrue("Upstream must start within 2s", upstreamActiveLatch.await(2, TimeUnit.SECONDS))

        // Emit a value — entry.sharedFlow (replay=1) buffers it; early subscriber receives it
        kotlinx.coroutines.runBlocking { upstreamSource.emit("value-before-late-attach") }

        assertTrue("Early subscriber must receive emission within 2s", earlyItemLatch.await(2, TimeUnit.SECONDS))

        // Attach late subscriber to the SAME hub entry (replay=1 must deliver the last item immediately)
        hub.attach(
            contractId = contractId,
            member = member,
            scope = scope,
            paramsHash = paramsHash,
            adapter = adapter,
            payload = null,
            streamEpoch = 1L,
            streamId = "late",
            latestOnly = true,
            onNext = { v ->
                lateItems.add(v)
                lateItemLatch.countDown()
            },
            onEnd = {},
        )

        // Late subscriber must receive the replayed last value without any new emission
        assertTrue(
            "Late subscriber must receive the replayed last-emitted value within 2s",
            lateItemLatch.await(2, TimeUnit.SECONDS),
        )

        assertTrue("Late subscriber items must not be empty", lateItems.isNotEmpty())
        // The value is wrapped in { "v" to rawValue } by StreamHub.attach's collect block
        val replayedValue = lateItems[0]["v"]
        assertNotNull("Replayed item must be non-null", replayedValue)
        assertTrue(
            "Replayed value must match what was emitted before late attach",
            replayedValue == "value-before-late-attach",
        )

        hub.cancelAll()
    }

    // ---- Integration: cancelling the returned Job (Router.closeStream) detaches --------

    /**
     * Verify-fix: Router.closeStream cancels the consumer Job returned by attach().
     * That cancellation must auto-detach the consumer (via invokeOnCompletion), so the
     * sole consumer closing releases the upstream provider Flow. This proves the refcount
     * lifecycle is wired through the Job — not only reachable via the standalone detach().
     */
    @Test
    fun `cancelling the returned consumer job releases the upstream (closeStream path)`() {
        val upstreamActiveLatch = CountDownLatch(1)
        val upstreamCancelledLatch = CountDownLatch(1)

        val source = MutableSharedFlow<Any?>(replay = 0)
        val adapter = object : InboundContractAdapter {
            override val stateInitials: Map<String, Any?> = emptyMap()
            override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? = null
            override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = null
            override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
            override fun openStream(member: String, payload: Map<String, Any?>?): Flow<Any?> =
                flow {
                    upstreamActiveLatch.countDown()
                    try {
                        source.collect { emit(it) }
                    } finally {
                        upstreamCancelledLatch.countDown()
                    }
                }
        }

        // Sole consumer — its Job is what Router tracks and cancels on closeStream.
        val job = hub.attach(
            contractId = "hub.close.test",
            member = "items",
            scope = Scope.Global,
            paramsHash = 0L,
            adapter = adapter,
            payload = null,
            streamEpoch = 1L,
            streamId = "only",
            onNext = {},
            onEnd = {},
        )

        assertTrue(
            "Upstream must start collecting within 2s",
            upstreamActiveLatch.await(2, TimeUnit.SECONDS),
        )

        // Simulate Router.closeStream: cancel the consumer Job. invokeOnCompletion must detach,
        // dropping refcount to 0 and cancelling the upstream provider collection.
        job.cancel()

        assertTrue(
            "Cancelling the sole consumer Job must release the upstream provider within 2s",
            upstreamCancelledLatch.await(2, TimeUnit.SECONDS),
        )
    }
}
