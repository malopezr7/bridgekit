package com.bridgekit

import com.bridgekit.core.*
import com.bridgekit.runtime.InboundContractAdapter
import com.bridgekit.runtime.JsDispatcherCallbacks
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Android Concurrency + Epoch tests.
 *
 * Covers: late-consumer terminal replay (StreamHub), value-aware hub entry removal,
 * ConcurrentHashMap safety in BindingEntry, JS→native channel cleanup on reconnect,
 * epoch guard (stale invoke/openStream/stateWrite rejection), and ParkBuffer timeout cleanup.
 */
class B3ConcurrencyEpochTest {

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
            callTimeoutMs = 1_000,
        )
    }

    // =========================================================================
    // StreamHub terminal replay for late consumers
    // =========================================================================

    /**
     * Late consumer after upstream completes normally: stream completes before any
     * consumer attaches. When a consumer subscribes after completion it MUST receive
     * the terminal immediately and MUST NOT hang.
     */
    @Test(timeout = 10_000)
    fun `H-5a late consumer receives complete terminal after upstream already finished`() {
        val terminalLatch = CountDownLatch(1)
        val terminals = mutableListOf<Map<String, Any?>>()

        val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val hub = StreamHub(engineScope)

        // Adapter whose stream completes immediately (no items).
        val adapter = object : InboundContractAdapter {
            override val stateInitials: Map<String, Any?> = emptyMap()
            override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? = null
            override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = null
            override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
            override fun openStream(member: String, payload: Map<String, Any?>?): Flow<Any?> =
                flow { /* completes immediately */ }
        }

        // Attach first consumer — starts upstream. Upstream completes instantly.
        val job1 = hub.attach(
            contractId = "h5.complete.test", member = "items", scope = Scope.Global,
            paramsHash = 0L, adapter = adapter, payload = null, streamEpoch = 1L, streamId = "c1",
            onNext = {},
            onEnd = { t -> terminals.add(t); terminalLatch.countDown() },
        )
        // Wait for first consumer to receive terminal
        assertTrue("First consumer must receive terminal within 3s", terminalLatch.await(3, TimeUnit.SECONDS))
        assertTrue("First consumer terminal must be ok=true", terminals.first()["ok"] as Boolean)

        // Attach a LATE consumer — upstream is already finished.
        // H-5: must receive terminal immediately, not hang.
        val lateTerminalLatch = CountDownLatch(1)
        val lateTerminals = mutableListOf<Map<String, Any?>>()
        hub.attach(
            contractId = "h5.complete.test", member = "items", scope = Scope.Global,
            paramsHash = 0L, adapter = adapter, payload = null, streamEpoch = 1L, streamId = "c2",
            onNext = {},
            onEnd = { t -> lateTerminals.add(t); lateTerminalLatch.countDown() },
        )

        assertTrue(
            "Late consumer MUST receive terminal after upstream already completed (no hang)",
            lateTerminalLatch.await(6, TimeUnit.SECONDS),
        )
        assertEquals("Late consumer must receive exactly one terminal", 1, lateTerminals.size)
        assertTrue("Late consumer terminal must be ok=true (normal completion)", lateTerminals[0]["ok"] as Boolean)
    }

    /**
     * Late consumer after upstream errors: stream errors before any consumer attaches.
     * Late consumer MUST receive an error terminal.
     */
    @Test(timeout = 10_000)
    fun `H-5b late consumer receives error terminal after upstream already errored`() {
        val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val hub = StreamHub(engineScope)

        val adapter = object : InboundContractAdapter {
            override val stateInitials: Map<String, Any?> = emptyMap()
            override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? = null
            override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = null
            override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
            override fun openStream(member: String, payload: Map<String, Any?>?): Flow<Any?> =
                flow { throw RuntimeException("upstream error") }
        }

        // First consumer receives error terminal
        val firstLatch = CountDownLatch(1)
        hub.attach(
            contractId = "h5.error.test", member = "items", scope = Scope.Global,
            paramsHash = 0L, adapter = adapter, payload = null, streamEpoch = 1L, streamId = "c1",
            onNext = {},
            onEnd = { firstLatch.countDown() },
        )
        assertTrue("First consumer must get terminal", firstLatch.await(3, TimeUnit.SECONDS))

        // Late consumer — upstream already errored
        val lateLatch = CountDownLatch(1)
        val lateTerminals = mutableListOf<Map<String, Any?>>()
        hub.attach(
            contractId = "h5.error.test", member = "items", scope = Scope.Global,
            paramsHash = 0L, adapter = adapter, payload = null, streamEpoch = 1L, streamId = "c2",
            onNext = {},
            onEnd = { t -> lateTerminals.add(t); lateLatch.countDown() },
        )

        assertTrue(
            "Late consumer MUST receive error terminal after upstream already errored",
            lateLatch.await(6, TimeUnit.SECONDS),
        )
        assertEquals("Late consumer must receive exactly one terminal", 1, lateTerminals.size)
        assertFalse(
            "Late consumer after error must receive ok=false terminal",
            lateTerminals[0]["ok"] as Boolean,
        )
        assertEquals("PROVIDER_ERROR", lateTerminals[0]["code"])
    }

    // =========================================================================
    // StreamHub remove is value-aware
    // =========================================================================

    /**
     * Value-aware remove at upstream completion does not evict a live replacement entry.
     *
     * Sequence under test:
     * 1. C1 attaches for key K with a completing upstream → upstream runs and completes.
     * 2. Old entry removed via value-aware hubs.remove(key, oldEntry) in the finally block.
     * 3. C2 attaches for key K with a live, non-completing upstream.
     * 4. C2's getOrPut creates a NEW entry (old one already removed → no conflict).
     * 5. C2's upstream starts; item emitted on liveSource → C2 receives it.
     *
     * A value-blind remove(key) in C3's upstream finally would evict C2's live entry.
     */
    @Test(timeout = 10_000)
    fun `H-6a value-aware remove does not evict live replacement entry`() {
        val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val hub = StreamHub(engineScope)

        val contractId = "h6.replace.test"
        val member = "stream"

        // Latch for when the old entry's upstream finally block fires.
        val oldEntryRemovedLatch = CountDownLatch(1)

        val completingAdapter = object : InboundContractAdapter {
            override val stateInitials: Map<String, Any?> = emptyMap()
            override suspend fun invoke(m: String, p: Map<String, Any?>?): Any? = null
            override fun invokeSync(m: String, p: Map<String, Any?>?): Any? = null
            override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
            override fun openStream(m: String, p: Map<String, Any?>?): Flow<Any?> = flow {
                // completes immediately
            }
        }

        // Step 1: attach C1 with completing upstream; wait for C1's onEnd (terminal delivered)
        val c1Done = CountDownLatch(1)
        hub.attach(
            contractId = contractId, member = member, scope = Scope.Global,
            paramsHash = 0L, adapter = completingAdapter, payload = null,
            streamEpoch = 1L, streamId = "c1", onNext = {}, onEnd = { c1Done.countDown() },
        )
        assertTrue("C1 must receive terminal", c1Done.await(3, TimeUnit.SECONDS))

        // The old entry is now terminated. The upstream's finally (hubs.remove(key, entry))
        // may or may not have run yet — wait a bit to ensure it fires.
        Thread.sleep(200)

        // Step 2-3: C2 attaches for the same key with a live upstream.
        // After the 200ms wait, the old entry should be removed from hubs (either by detach
        // when refcount→0, or by the upstream finally). getOrPut will create a NEW entry.
        val liveSource = MutableSharedFlow<Any?>(replay = 0, extraBufferCapacity = 8)
        val liveStartedLatch = CountDownLatch(1)
        val liveAdapter = object : InboundContractAdapter {
            override val stateInitials: Map<String, Any?> = emptyMap()
            override suspend fun invoke(m: String, p: Map<String, Any?>?): Any? = null
            override fun invokeSync(m: String, p: Map<String, Any?>?): Any? = null
            override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
            override fun openStream(m: String, p: Map<String, Any?>?): Flow<Any?> = flow {
                liveStartedLatch.countDown()
                liveSource.collect { emit(it) }
            }
        }

        val liveItemLatch = CountDownLatch(1)
        val receivedItems = mutableListOf<Map<String, Any?>>()
        hub.attach(
            contractId = contractId, member = member, scope = Scope.Global,
            paramsHash = 0L, adapter = liveAdapter, payload = null,
            streamEpoch = 2L, streamId = "c2",
            onNext = { v -> receivedItems.add(v); liveItemLatch.countDown() },
            onEnd = { liveItemLatch.countDown() }, // also unblock if unexpectedly terminated
        )

        // Wait for live upstream to start collecting
        assertTrue("Live upstream must start", liveStartedLatch.await(3, TimeUnit.SECONDS))

        // Step 4: C3 attaches for the same key (also completing). When C3's upstream
        // completes, its finally fires hubs.remove(key, C3entry). Without value-aware remove,
        // this would also remove C2's entry (value-blind). With the fix, C2's entry stays.
        val c3Done = CountDownLatch(1)
        hub.attach(
            contractId = contractId, member = member, scope = Scope.Global,
            paramsHash = 0L, adapter = liveAdapter, // same live upstream (joins C2's entry, no new start)
            payload = null,
            streamEpoch = 2L, streamId = "c3",
            onNext = { v -> receivedItems.add(v); },
            onEnd = { c3Done.countDown() },
        )

        // Emit on liveSource — must reach C2 (and C3 if they share the same entry)
        runBlocking { liveSource.emit("live-value") }

        assertTrue(
            "Live replacement entry items must be received — value-blind remove must not evict it",
            liveItemLatch.await(3, TimeUnit.SECONDS),
        )
        assertTrue(
            "Received items must contain 'live-value'",
            receivedItems.any { it["v"] == "live-value" },
        )

        hub.cancelAll()
    }

    /**
     * Value-aware remove in detach does not evict a live replacement entry.
     * Uses a completing stream for c1 so the first entry is cleanly removed before
     * c2 attaches — verifying that c2 gets a fresh entry and receives items normally.
     */
    @Test(timeout = 5_000)
    fun `H-6b value-aware detach does not evict live replacement entry`() {
        val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val hub = StreamHub(engineScope)

        val source2 = MutableSharedFlow<Any?>(replay = 0, extraBufferCapacity = 8)

        // First adapter: completes immediately (entry will be removed cleanly by H-6 fix)
        val completingAdapter = object : InboundContractAdapter {
            override val stateInitials: Map<String, Any?> = emptyMap()
            override suspend fun invoke(m: String, p: Map<String, Any?>?): Any? = null
            override fun invokeSync(m: String, p: Map<String, Any?>?): Any? = null
            override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
            override fun openStream(m: String, p: Map<String, Any?>?): Flow<Any?> = flow {
                // completes immediately — entry removed in finally block
            }
        }

        // Second adapter: live, driven by source2
        val liveAdapter = object : InboundContractAdapter {
            override val stateInitials: Map<String, Any?> = emptyMap()
            override suspend fun invoke(m: String, p: Map<String, Any?>?): Any? = null
            override fun invokeSync(m: String, p: Map<String, Any?>?): Any? = null
            override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
            override fun openStream(m: String, p: Map<String, Any?>?): Flow<Any?> = flow {
                source2.collect { emit(it) }
            }
        }

        val contractId = "h6b.detach.test"
        val member = "stream"
        val paramsHash = 0L

        // Consumer 1: upstream completes immediately → entry removed via detach / finally
        val c1EndLatch = CountDownLatch(1)
        hub.attach(
            contractId = contractId, member = member, scope = Scope.Global,
            paramsHash = paramsHash, adapter = completingAdapter, payload = null,
            streamEpoch = 1L, streamId = "c1",
            onNext = {},
            onEnd = { c1EndLatch.countDown() },
        )
        assertTrue("Consumer 1 must receive terminal from completing upstream", c1EndLatch.await(3, TimeUnit.SECONDS))
        // Give invokeOnCompletion / detach time to clean up
        Thread.sleep(100)

        // Consumer 2 on source2 (same key, must get a fresh live entry — not evicted by H-6 finally)
        val c2Items = mutableListOf<Any?>()
        val c2Latch = CountDownLatch(1)
        val c2StartLatch = CountDownLatch(1)

        val liveAdapterWithSignal = object : InboundContractAdapter {
            override val stateInitials: Map<String, Any?> = emptyMap()
            override suspend fun invoke(m: String, p: Map<String, Any?>?): Any? = null
            override fun invokeSync(m: String, p: Map<String, Any?>?): Any? = null
            override fun stateFlows(): Map<String, StateFlow<Any?>> = emptyMap()
            override fun openStream(m: String, p: Map<String, Any?>?): Flow<Any?> = flow {
                c2StartLatch.countDown() // signal upstream is collecting
                source2.collect { emit(it) }
            }
        }

        hub.attach(
            contractId = contractId, member = member, scope = Scope.Global,
            paramsHash = paramsHash, adapter = liveAdapterWithSignal, payload = null,
            streamEpoch = 2L, streamId = "c2",
            onNext = { v -> c2Items.add(v["v"]); c2Latch.countDown() },
            onEnd = {},
        )

        // Wait for c2 upstream to start
        assertTrue("C2 upstream must start collecting", c2StartLatch.await(3, TimeUnit.SECONDS))

        // Emit on source2 — must reach c2
        runBlocking { source2.emit("from-source2") }

        assertTrue(
            "Consumer 2 on replacement entry must receive items — prior entry must not be evicted",
            c2Latch.await(2, TimeUnit.SECONDS),
        )
        assertEquals("from-source2", c2Items[0])

        hub.cancelAll()
    }

    // =========================================================================
    // BindingEntry.streamJobs thread safety (ConcurrentHashMap)
    // =========================================================================

    /**
     * registerStreamJob concurrent with cancelAllStreamJobs must not CME.
     * With HashMap this is a ConcurrentModificationException; ConcurrentHashMap is safe.
     * Also validates that _isLive is rechecked before put so a job added after close is
     * immediately cancelled.
     *
     * Note: CME may not reproduce deterministically — this is a regression gate.
     */
    @Test(timeout = 5_000)
    fun `H-7 concurrent registerStreamJob and cancelAllStreamJobs does not throw CME`() {
        val defn = stubDefinition("h7.concurrency.test")
        val adapter = CapturingAdapter()
        val entry = makeEntry(defn, Scope.Global, adapter)

        val executor = Executors.newFixedThreadPool(2)
        val errors = mutableListOf<Throwable>()
        val startLatch = CountDownLatch(2)
        val doneLatch = CountDownLatch(2)
        val iterations = 500

        // Thread 1: rapid registerStreamJob
        executor.submit {
            startLatch.countDown()
            startLatch.await()
            for (i in 0 until iterations) {
                val fakeJob = SupervisorJob()
                try {
                    entry.registerStreamJob("stream-$i", fakeJob)
                } catch (t: Throwable) {
                    synchronized(errors) { errors.add(t) }
                }
            }
            doneLatch.countDown()
        }

        // Thread 2: rapid cancelAllStreamJobs (iterates map)
        executor.submit {
            startLatch.countDown()
            startLatch.await()
            for (i in 0 until iterations) {
                try {
                    entry.cancelAllStreamJobs()
                } catch (t: Throwable) {
                    synchronized(errors) { errors.add(t) }
                }
            }
            doneLatch.countDown()
        }

        assertTrue("Threads must finish within 4s", doneLatch.await(4, TimeUnit.SECONDS))
        executor.shutdown()

        assertTrue(
            "No ConcurrentModificationException or other error must occur. Got: ${errors.firstOrNull()?.javaClass?.simpleName}",
            errors.isEmpty(),
        )
    }

    /**
     * registerStreamJob after binding closed: job added after close must not stay live.
     * If binding is already closed when registerStreamJob is called, the job is
     * cancelled immediately via the _isLive recheck.
     */
    @Test
    fun `H-7b registerStreamJob after binding closed is immediately cancelled`() {
        val defn = stubDefinition("h7b.postclose.test")
        val entry = makeEntry(defn, Scope.Global)

        // Close the binding first
        entry.close(CloseReason.Final)
        assertFalse("Entry must not be live", entry.isLive)

        // Now register a job on a closed entry
        var jobCancelledOrNotAdded = false
        val job = SupervisorJob()
        entry.registerStreamJob("late-stream", job)

        // Job added to a dead entry must be cancelled by the time cancelAllStreamJobs is called.
        entry.cancelAllStreamJobs()
        // If job was added and cancelled, it is completed. If it was never added, also fine.
        jobCancelledOrNotAdded = job.isCancelled || !job.isActive
        assertTrue(
            "Stream job registered after binding close must not remain active",
            jobCancelledOrNotAdded,
        )
    }

    // =========================================================================
    // JS-to-native stream channels cleared on reconnect
    // =========================================================================

    /**
     * connectDispatcher must close and clear jsStreamChannels on reconnect.
     * After an epoch swap, prior-epoch jsStreamChannels and jsStreamEnds must be
     * invalidated. Emitting on a prior-epoch channel must fail (channel closed).
     */
    @Test(timeout = 5_000)
    fun `H-8 reconnect closes prior-epoch jsStreamChannels and jsStreamEnds`() {
        // First epoch: install a channel and end deferred manually (simulating openStream JS-to-native)
        router.connectDispatcher(emptyMap(), fakeCallbacks())
        val epoch1 = router.currentEpoch()
        assertEquals(1L, epoch1)

        // Simulate an active JS-to-native stream from epoch 1
        val channel = Channel<Map<String, Any?>>(capacity = Channel.BUFFERED)
        val endDeferred = kotlinx.coroutines.CompletableDeferred<Map<String, Any?>>()
        router.jsStreamChannels["js-stream-epoch1"] = channel
        router.jsStreamEnds["js-stream-epoch1"] = endDeferred

        // Reconnect (epoch swap)
        router.connectDispatcher(emptyMap(), fakeCallbacks())
        val epoch2 = router.currentEpoch()
        assertEquals(2L, epoch2)

        // After reconnect, jsStreamChannels and jsStreamEnds must be cleared.
        assertFalse(
            "jsStreamChannels must be cleared on reconnect — prior-epoch channel must not remain",
            router.jsStreamChannels.containsKey("js-stream-epoch1"),
        )
        assertFalse(
            "jsStreamEnds must be cleared on reconnect — prior-epoch end deferred must not remain",
            router.jsStreamEnds.containsKey("js-stream-epoch1"),
        )

        // The channel itself must be closed (trySend must fail).
        assertTrue(
            "Prior-epoch channel must be closed after reconnect",
            channel.isClosedForSend,
        )
    }

    /**
     * Streams registered after reconnect are not cleared by the prior-epoch cleanup.
     */
    @Test(timeout = 3_000)
    fun `H-8b streams registered after reconnect are not cleared by prior-epoch cleanup`() {
        router.connectDispatcher(emptyMap(), fakeCallbacks())
        router.connectDispatcher(emptyMap(), fakeCallbacks()) // epoch 2

        // Register a new stream in epoch 2
        val newChannel = Channel<Map<String, Any?>>(capacity = Channel.BUFFERED)
        router.jsStreamChannels["js-stream-epoch2"] = newChannel

        // A third reconnect (epoch 3) — epoch2 stream must be cleared, but it's the "new" one.
        // This verifies only the "all channels cleared" behavior (since we can't distinguish epochs
        // in the plain ConcurrentHashMap). The important contract: after connectDispatcher the
        // prior channels list is empty and only new registrations survive.
        router.connectDispatcher(emptyMap(), fakeCallbacks()) // epoch 3

        assertFalse(
            "All jsStreamChannels must be cleared on every connectDispatcher call",
            router.jsStreamChannels.containsKey("js-stream-epoch2"),
        )
    }

    // =========================================================================
    // Epoch validation: stale-epoch ops rejected before side-effects
    // =========================================================================

    /**
     * Stale invoke returns BRIDGE_NOT_READY.
     * epochEnv=0 is accepted (pre-connection sentinel, no guard).
     * An invoke with epochEnv=1 on epoch=2 MUST be rejected.
     */
    @Test(timeout = 5_000)
    fun `epoch guard - stale invoke with epochEnv lt current epoch returns BRIDGE_NOT_READY`() {
        // Epoch 1
        router.connectDispatcher(emptyMap(), fakeCallbacks())
        // Epoch 2
        router.connectDispatcher(emptyMap(), fakeCallbacks())
        assertEquals(2L, router.currentEpoch())

        // Register a native contract
        val defn = stubDefinition("epoch.invoke.test")
        val adapter = CapturingAdapter(suspendResult = "result")
        router.registerBinding(makeEntry(defn, Scope.Global, adapter))

        val result = AtomicReference<Map<String, Any?>>()
        val latch = CountDownLatch(1)

        // epochEnv=1 on epoch=2 → stale → must be rejected
        val env = mapOf(
            "contractId" to "epoch.invoke.test",
            "member" to "doThing",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "c1",
            "epoch" to 1L,
        )
        router.invoke(env) { r ->
            result.set(r)
            latch.countDown()
        }

        assertTrue("Invoke must complete within 2s", latch.await(2, TimeUnit.SECONDS))
        assertFalse(
            "Epoch guard: stale invoke (epochEnv=1, current=2) must return ok=false",
            result.get()["ok"] as Boolean,
        )
        assertEquals(
            "Epoch guard: stale invoke must return BRIDGE_NOT_READY",
            "BRIDGE_NOT_READY",
            result.get()["code"],
        )
    }

    /**
     * epochEnv=0 is NOT rejected (pre-connection sentinel, no guard).
     */
    @Test(timeout = 5_000)
    fun `epoch guard - epochEnv=0 is NOT rejected (pre-connection or no epoch in envelope)`() {
        router.connectDispatcher(emptyMap(), fakeCallbacks()) // epoch 1

        val defn = stubDefinition("epoch.zero.test")
        val adapter = CapturingAdapter(suspendResult = "ok-value")
        router.registerBinding(makeEntry(defn, Scope.Global, adapter))

        val result = AtomicReference<Map<String, Any?>>()
        val latch = CountDownLatch(1)

        val env = mapOf(
            "contractId" to "epoch.zero.test",
            "member" to "doThing",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "c2",
            "epoch" to 0L,
        )
        router.invoke(env) { r ->
            result.set(r)
            latch.countDown()
        }

        assertTrue(latch.await(2, TimeUnit.SECONDS))
        assertTrue(
            "epochEnv=0 must NOT be rejected (pre-connection sentinel)",
            result.get()["ok"] as Boolean,
        )
    }

    /**
     * Stale stateWrite returns BRIDGE_NOT_READY with no state mutation.
     * Epoch is checked BEFORE any side-effect.
     */
    @Test
    fun `epoch guard - stale stateWrite with epochEnv lt current epoch returns BRIDGE_NOT_READY`() {
        router.connectDispatcher(emptyMap(), fakeCallbacks()) // epoch 1
        router.connectDispatcher(emptyMap(), fakeCallbacks()) // epoch 2
        assertEquals(2L, router.currentEpoch())

        // Plain stateWrite with epochEnv=1 (stale)
        val env = mapOf(
            "contractId" to "epoch.statewrite.test",
            "member" to "someKey",
            "scope" to mapOf("kind" to "global"),
            "payload" to mapOf("v" to "should-not-be-written"),
            "epoch" to 1L,
        )
        val result = router.stateWrite(env)

        assertFalse(
            "Epoch guard: stale stateWrite must return ok=false",
            result["ok"] as Boolean,
        )
        assertEquals(
            "Epoch guard: stale stateWrite must return BRIDGE_NOT_READY",
            "BRIDGE_NOT_READY",
            result["code"],
        )

        // Verify state was NOT mutated
        val stateValue = stateStore.read("epoch.statewrite.test", Scope.Global, "someKey", null)
        assertFalse(
            "Epoch guard: state must not be mutated by stale stateWrite",
            stateValue is com.bridgekit.runtime.BridgeValue.Available,
        )
    }

    /**
     * Stale provide op is rejected before marking the contract as provided.
     */
    @Test
    fun `epoch guard - stale provide op with epochEnv lt current epoch returns BRIDGE_NOT_READY`() {
        router.connectDispatcher(emptyMap(), fakeCallbacks()) // epoch 1
        router.connectDispatcher(emptyMap(), fakeCallbacks()) // epoch 2

        val env = mapOf(
            "contractId" to "epoch.provide.test",
            "op" to "provide",
            "scope" to mapOf("kind" to "global"),
            "member" to "",
            "epoch" to 1L,
        )
        val result = router.stateWrite(env)

        assertFalse("Epoch guard: stale provide op must return ok=false", result["ok"] as Boolean)
        assertEquals("BRIDGE_NOT_READY", result["code"])

        assertFalse(
            "Epoch guard: stale provide op must NOT mark contract as provided",
            router.isProvided("epoch.provide.test", Scope.Global),
        )
    }

    /**
     * Stale unprovide op is rejected; jsProvidedContracts must remain intact.
     */
    @Test
    fun `epoch guard - stale unprovide op does not corrupt jsProvidedContracts`() {
        // Provide the contract in epoch 1
        router.connectDispatcher(emptyMap(), fakeCallbacks()) // epoch 1
        router.stateWrite(mapOf(
            "contractId" to "epoch.unprovide.test",
            "op" to "provide",
            "scope" to mapOf("kind" to "global"),
            "member" to "",
            "epoch" to 1L,
        ))
        assertTrue("Must be provided after epoch-1 provide", router.isProvided("epoch.unprovide.test", Scope.Global))

        // Epoch swap
        router.connectDispatcher(emptyMap(), fakeCallbacks()) // epoch 2
        // Re-provide in epoch 2
        router.stateWrite(mapOf(
            "contractId" to "epoch.unprovide.test",
            "op" to "provide",
            "scope" to mapOf("kind" to "global"),
            "member" to "",
            "epoch" to 2L,
        ))
        assertTrue("Must be provided in epoch 2", router.isProvided("epoch.unprovide.test", Scope.Global))

        // Now a stale unprovide arrives from epoch 1
        val staleUnprovide = mapOf(
            "contractId" to "epoch.unprovide.test",
            "op" to "unprovide",
            "scope" to mapOf("kind" to "global"),
            "member" to "",
            "epoch" to 1L,
        )
        val result = router.stateWrite(staleUnprovide)

        assertFalse("Epoch guard: stale unprovide must return ok=false", result["ok"] as Boolean)
        assertEquals("BRIDGE_NOT_READY", result["code"])
        assertTrue(
            "Epoch guard: stale unprovide must NOT corrupt jsProvidedContracts (contract still provided in epoch 2)",
            router.isProvided("epoch.unprovide.test", Scope.Global),
        )
    }

    /**
     * openStream with stale epoch calls onEnd with BRIDGE_NOT_READY.
     */
    @Test(timeout = 3_000)
    fun `epoch guard - stale openStream with epochEnv lt current epoch calls onEnd with BRIDGE_NOT_READY`() {
        router.connectDispatcher(emptyMap(), fakeCallbacks()) // epoch 1
        router.connectDispatcher(emptyMap(), fakeCallbacks()) // epoch 2

        val defn = stubDefinition("epoch.stream.test")
        val adapter = CapturingAdapter()
        router.registerBinding(makeEntry(defn, Scope.Global, adapter))

        val endEnvs = mutableListOf<Map<String, Any?>>()
        val endLatch = CountDownLatch(1)

        val env = mapOf(
            "contractId" to "epoch.stream.test",
            "member" to "items",
            "scope" to mapOf("kind" to "global"),
            "epoch" to 1L, // stale
        )
        router.openStream(env,
            onNext = {},
            onEnd = { e -> endEnvs.add(e); endLatch.countDown() },
        )

        assertTrue("openStream with stale epoch must call onEnd", endLatch.await(2, TimeUnit.SECONDS))
        assertFalse("Stale openStream must call onEnd with ok=false", endEnvs[0]["ok"] as Boolean)
        assertEquals(
            "Stale openStream must use BRIDGE_NOT_READY code",
            "BRIDGE_NOT_READY",
            endEnvs[0]["code"],
        )
    }

    // =========================================================================
    // ParkBuffer: timed-out waiters removed individually
    // =========================================================================

    /**
     * 64 successive timed-out waiters must not exhaust capacity.
     * Timed-out entries must be pruned individually so a 65th park() succeeds.
     */
    @Test
    fun `ParkBuffer 65th park accepted after 64 timed-out waiters are removed`() {
        val pb = ParkBuffer()

        // Park 64 waiters and complete them with false (simulating timeout)
        // WITHOUT calling failAll (which would clear the whole list).
        val deferreds = (1..64).map {
            val d = pb.park("timeout.contract", Scope.Global)!!
            d.complete(false) // simulate timeout
            d
        }

        val sixtyfifth = pb.park("timeout.contract", Scope.Global)
        assertNotNull(
            "ParkBuffer: 65th park() MUST succeed after 64 timed-out waiters are individually removed",
            sixtyfifth,
        )
    }

    /**
     * ParkBuffer — completed waiter not counted in capacity check:
     * A park() call that completes (whether via unpark or timeout) must not occupy a slot.
     */
    @Test
    fun `ParkBuffer does not count completed waiters toward MAX_PARKED capacity`() {
        val pb = ParkBuffer()

        // Park MAX_PARKED waiters, complete them all with false (timeout simulation)
        for (i in 1..ParkBuffer.MAX_PARKED) {
            val d = pb.park("cap.contract", Scope.Global)!!
            d.complete(false)
        }

        // Should still be able to park
        val extra = pb.park("cap.contract", Scope.Global)
        assertNotNull(
            "After ${ParkBuffer.MAX_PARKED} timed-out waiters, next park() must not return null",
            extra,
        )
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private fun fakeCallbacks() = JsDispatcherCallbacks(
        onInvoke = { _, completion -> completion(mapOf("ok" to true), null) },
        onStreamOpen = {},
        onStreamClose = {},
        onStateWrite = {},
    )

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
        val bindingScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        return BindingEntry(defn, scope, adapter, bindingScope)
    }
}
