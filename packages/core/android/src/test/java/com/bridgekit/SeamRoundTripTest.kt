package com.bridgekit

import com.bridgekit.contracts.hardening.GetUserByIdParams
import com.bridgekit.contracts.hardening.GetUserByIdResult
import com.bridgekit.contracts.hardening.HardeningFixture
import com.bridgekit.contracts.hardening.HardeningFixtureContract
import com.bridgekit.contracts.hardening.NotifyParams
import com.bridgekit.contracts.hardening.TickStreamValue
import com.bridgekit.core.BridgeKit
import com.bridgekit.core.MainThreadChecker
import com.bridgekit.core.OutboundCallerImpl
import com.bridgekit.core.ParkBuffer
import com.bridgekit.core.Router
import com.bridgekit.core.Scope
import com.bridgekit.core.StateStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Ignore
import org.junit.Test

/**
 * W0-3: Real-seam JVM round-trip tests per marker per direction.
 *
 * Uses the real Router + real HardeningFixtureContract adapter.
 * Replaces only the JNI/Nitro boundary with StubJsDispatcher.
 *
 * Markers covered:
 *  - Async  (Query)  — JS→native and native→JS
 *  - Void   (fire)   — JS→native and native→JS
 *  - Stream          — native→JS (native provides, JS receives via Router.openStream)
 *  - State           — native→JS (native provides state; stateWrite notification to JS)
 */
class SeamRoundTripTest {

    private lateinit var router: Router
    private lateinit var bridgeKit: BridgeKit
    private lateinit var stub: StubJsDispatcher

    @Before
    fun setup() {
        stub = StubJsDispatcher()
        router = Router(StateStore(), ParkBuffer(), readinessTimeoutMs = 200, callTimeoutMs = 2_000)
        bridgeKit = BridgeKit(router)
    }

    // ---- Async (Query) JS→native -----------------------------------------------

    /**
     * JS encodes { id: "abc" } and hands AnyMap to Router.invoke().
     * Router dispatches to the real HardeningFixtureContract inbound adapter.
     * Assert the impl is called with id = "abc" and not a fabricated default.
     */
    @Ignore(
        "QUARANTINED(WS-5): timing-sensitive under slow CI runners; " +
            "StreamHub races tracked as RT-AND-03/RT-AND-04 - un-ignore when WS-5 fixes the hub"
    )
    @Test
    fun `Async JS-to-native — getUserById decodes payload and calls impl with correct id`() = runTest {
        var receivedId: String? = null
        val impl = fakeImpl(
            onGetUser = { params ->
                receivedId = params.id
                GetUserByIdResult(userId = params.id, name = "Alice", score = 99.0)
            },
        )

        bridgeKit.provide(HardeningFixtureContract, Scope.Global) { impl }

        val env = mapOf(
            "contractId" to "hardening.fixture",
            "member" to "getUserById",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "test-async-js-native",
            "epoch" to 1,
            "payload" to mapOf("id" to "abc"),
        )

        var result: Map<String, Any?>? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        router.invoke(env) { r ->
            result = r
            latch.countDown()
        }

        assertTrue("Result received in time", latch.await(3, java.util.concurrent.TimeUnit.SECONDS))
        assertNotNull(result)
        assertEquals(true, result!!["ok"])
        assertEquals("abc", receivedId)

        // The result value is the encoded map from the adapter
        @Suppress("UNCHECKED_CAST")
        val value = result!!["value"] as? Map<String, Any?>
        assertNotNull("Result value must be a map", value)
        assertEquals("abc", value!!["userId"])
        assertEquals("Alice", value["name"])
    }

    // ---- Void (fire) JS→native -------------------------------------------------

    /**
     * JS fires notify (Void marker). The adapter routes to impl.notify().
     * Assert impl.notify() is called exactly once with the correct payload.
     */
    @Ignore(
        "QUARANTINED(WS-5): timing-sensitive under slow CI runners; " +
            "StreamHub races tracked as RT-AND-03/RT-AND-04 - un-ignore when WS-5 fixes the hub"
    )
    @Test
    fun `Void JS-to-native — notify fires impl exactly once with decoded params`() = runTest {
        var notifyCount = 0
        var lastMessage: String? = null

        val impl = fakeImpl(
            onNotify = { params ->
                notifyCount++
                lastMessage = params.message
            },
        )

        bridgeKit.provide(HardeningFixtureContract, Scope.Global) { impl }

        val env = mapOf(
            "contractId" to "hardening.fixture",
            "member" to "notify",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "test-void-js-native",
            "epoch" to 1,
            "payload" to mapOf("message" to "hello bridge"),
        )

        var result: Map<String, Any?>? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        router.invoke(env) { r ->
            result = r
            latch.countDown()
        }

        assertTrue("Result received in time", latch.await(3, java.util.concurrent.TimeUnit.SECONDS))
        assertEquals(true, result!!["ok"])
        assertNull("Void member must return null value", result!!["value"])
        assertEquals(1, notifyCount)
        assertEquals("hello bridge", lastMessage)
    }

    // ---- Async (Query) native→JS -----------------------------------------------

    /**
     * Native consumes a JS-provided contract via OutboundCallerImpl.invoke().
     * The StubJsDispatcher records the invocation and returns a canned response.
     * Assert the caller receives the decoded result from the stub.
     */
    @Test
    fun `Async native-to-JS — OutboundCaller routes to JS dispatcher and returns result`() = runTest {
        // Connect the JS dispatcher (stub) so OutboundCallerImpl can route to it
        router.connectDispatcher(emptyMap(), stub.asCallbacks())

        // Mark JS as the provider so tryConsume works
        router.markJsProvided("hardening.fixture")

        // Canned response: JS returns { ok: true, value: { userId: "js-user", name: "Bob", score: 5.0 } }
        stub.nextInvokeResponse = mapOf(
            "ok" to true,
            "value" to mapOf("userId" to "js-user", "name" to "Bob", "score" to 5.0),
        )

        val caller = OutboundCallerImpl(
            contractId = "hardening.fixture",
            scope = Scope.Global,
            router = router,
            mainThreadChecker = MainThreadChecker { false },
            readinessTimeoutMs = 200,
            callTimeoutMs = 1_000,
        )

        val client = HardeningFixtureContract.outbound(caller)

        // This calls JS via the stub dispatcher
        val result = client.getUserById(GetUserByIdParams(id = "native-req"))

        assertEquals(1, stub.invocations.size)
        val invokedMember = stub.invocations[0]["member"]
        assertEquals("getUserById", invokedMember)

        // The outbound proxy decodes the result map into the typed GetUserByIdResult
        assertEquals("js-user", result.userId)
        assertEquals("Bob", result.name)
        assertEquals(5.0, result.score, 0.0001)
    }

    // ---- Void (fire) native→JS -------------------------------------------------

    /**
     * Native fires a Void method on a JS-provided contract.
     * OutboundCallerImpl.fire() dispatches via the JS dispatcher without awaiting a result.
     * Assert the StubJsDispatcher records the invocation.
     */
    @Ignore(
        "QUARANTINED(WS-5): timing-sensitive under slow CI runners; " +
            "StreamHub races tracked as RT-AND-03/RT-AND-04 - un-ignore when WS-5 fixes the hub"
    )
    @Test
    fun `Void native-to-JS — fire dispatches to JS dispatcher asynchronously`() = runTest {
        router.connectDispatcher(emptyMap(), stub.asCallbacks())
        router.markJsProvided("hardening.fixture")

        val caller = OutboundCallerImpl(
            contractId = "hardening.fixture",
            scope = Scope.Global,
            router = router,
            mainThreadChecker = MainThreadChecker { false },
            readinessTimeoutMs = 200,
            callTimeoutMs = 1_000,
        )

        val client = HardeningFixtureContract.outbound(caller)

        // fire() dispatches async — give it time to settle
        client.notify(NotifyParams(message = "fire-test"))

        withTimeout(1_000) {
            while (stub.invocations.isEmpty()) {
                delay(10)
            }
        }

        val invokedMember = stub.invocations[0]["member"]
        assertEquals("notify", invokedMember)

        @Suppress("UNCHECKED_CAST")
        val payload = stub.invocations[0]["payload"] as? Map<String, Any?>
        assertEquals("fire-test", payload?.get("message"))
    }

    // ---- Stream native→JS -------------------------------------------------------

    /**
     * Native provides a stream. JS side opens the stream via Router.openStream().
     * Native emits 3 items then completes. Assert StubJsDispatcher (acting as JS receiver)
     * received 3 onNext calls and 1 onEnd call.
     */
    @Ignore("QUARANTINED(WS-5): timing-sensitive under slow CI runners; StreamHub races tracked as RT-AND-03/RT-AND-04 — un-ignore when WS-5 fixes the hub")
    @Test
    fun `Stream native-to-JS — emits 3 items then onEnd reaches JS`() = runTest {
        val received = mutableListOf<Map<String, Any?>>()
        var endEnv: Map<String, Any?>? = null

        val ticks = listOf(TickStreamValue(1.0), TickStreamValue(2.0), TickStreamValue(3.0))
        val impl = fakeImpl(tickStream = kotlinx.coroutines.flow.flowOf(*ticks.toTypedArray()))

        bridgeKit.provide(HardeningFixtureContract, Scope.Global) { impl }

        val env = mapOf(
            "contractId" to "hardening.fixture",
            "member" to "tickStream",
            "scope" to mapOf("kind" to "global"),
            "epoch" to 1,
        )

        val endLatch = java.util.concurrent.CountDownLatch(1)
        router.openStream(
            env = env,
            onNext = { v -> received.add(v) },
            onEnd = { e ->
                endEnv = e
                endLatch.countDown()
            },
        )

        assertTrue("Stream end received in time", endLatch.await(3, java.util.concurrent.TimeUnit.SECONDS))

        assertEquals("Expected 3 stream items", 3, received.size)
        // W3: stream items are now encoded via HardeningFixtureCodecs.encodeTickStreamValue()
        // so onNext receives { "v" to Map<String, Any?> { "tick" to Double } }
        @Suppress("UNCHECKED_CAST")
        val item0Map = received[0]["v"] as? Map<String, Any?>
        assertNotNull("First item must be an encoded map", item0Map)
        assertEquals(1.0, (item0Map!!["tick"] as? Number)?.toDouble() ?: -1.0, 0.0001)

        @Suppress("UNCHECKED_CAST")
        val item1Map = received[1]["v"] as? Map<String, Any?>
        assertNotNull("Second item must be an encoded map", item1Map)
        assertEquals(2.0, (item1Map!!["tick"] as? Number)?.toDouble() ?: -1.0, 0.0001)

        @Suppress("UNCHECKED_CAST")
        val item2Map = received[2]["v"] as? Map<String, Any?>
        assertNotNull("Third item must be an encoded map", item2Map)
        assertEquals(3.0, (item2Map!!["tick"] as? Number)?.toDouble() ?: -1.0, 0.0001)

        assertNotNull("onEnd must be called", endEnv)
        assertEquals(true, endEnv!!["ok"])
    }

    // ---- State native→JS -------------------------------------------------------

    /**
     * Native provides state. When the state value changes, the Router propagates the
     * change to JS via JsDispatcherCallbacks.onStateWrite.
     * Assert the stub receives the state update with the correct value.
     */
    @Test
    fun `State native-to-JS — state change notifies JS via dispatcher`() = runTest {
        // Connect the JS dispatcher so the router can push state updates
        router.connectDispatcher(emptyMap(), stub.asCallbacks())

        val statusFlow = MutableStateFlow("idle")
        val impl = fakeImpl(statusOverride = statusFlow)

        bridgeKit.provide(HardeningFixtureContract, Scope.Global) { impl }

        // Observe the state so the router registers an observer
        val obsEnv = mapOf(
            "contractId" to "hardening.fixture",
            "member" to "status",
            "scope" to mapOf("kind" to "global"),
        )
        router.stateObserve(obsEnv) { env ->
            stub.stateWrites.add(env)
        }

        // Seed the state through the StateStore directly (simulating native push)
        router.stateStore.setNativeValue("hardening.fixture", Scope.Global, "status", "active")

        // Give the observation callback time to fire
        withTimeout(1_000) {
            while (stub.stateWrites.isEmpty()) {
                delay(10)
            }
        }

        assertTrue("State write must be delivered to observer", stub.stateWrites.isNotEmpty())
        val stateWrite = stub.stateWrites.first { it.containsKey("v") }
        assertEquals("active", stateWrite["v"])
    }

    // ---- State JS→native -------------------------------------------------------

    /**
     * JS writes a state value for a JS-provided contract. Assert the state is stored
     * and readable via stateRead.
     */
    @Test
    fun `State JS-to-native — stateWrite stores value readable via stateRead`() {
        val writeEnv = mapOf(
            "contractId" to "hardening.fixture",
            "member" to "count",
            "scope" to mapOf("kind" to "global"),
            "payload" to mapOf("v" to 42.0),
        )

        val writeResult = router.stateWrite(writeEnv)
        assertEquals("stateWrite should succeed for JS-provided contract", true, writeResult["ok"])

        val readEnv = mapOf(
            "contractId" to "hardening.fixture",
            "member" to "count",
            "scope" to mapOf("kind" to "global"),
        )
        val readResult = router.stateRead(readEnv)
        assertEquals(true, readResult["ok"])

        @Suppress("UNCHECKED_CAST")
        val wrapped = readResult["value"] as? Map<String, Any?>
        assertEquals(42.0, wrapped?.get("v"))
    }

    // ---- W1-5: missing required field → VALIDATION_FAILED through the Router ----

    /**
     * JS sends an invoke with a payload missing the required `id` field. The generated
     * decoder throws BridgeKitDecodeException; the Router maps it to VALIDATION_FAILED
     * and the provider is NOT dispatched with a fabricated default.
     */
    @Ignore(
        "QUARANTINED(WS-5): timing-sensitive under slow CI runners; " +
            "StreamHub races tracked as RT-AND-03/RT-AND-04 - un-ignore when WS-5 fixes the hub"
    )
    @Test
    fun `Async JS-to-native — missing required field returns VALIDATION_FAILED`() = runTest {
        var implCalled = false
        val impl = fakeImpl(
            onGetUser = { params ->
                implCalled = true
                GetUserByIdResult(userId = params.id, name = "Alice", score = 1.0)
            },
        )
        bridgeKit.provide(HardeningFixtureContract, Scope.Global) { impl }

        val env = mapOf(
            "contractId" to "hardening.fixture",
            "member" to "getUserById",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "test-validation-failed",
            "epoch" to 1,
            "payload" to emptyMap<String, Any?>(), // missing "id"
        )

        var result: Map<String, Any?>? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        router.invoke(env) { r ->
            result = r
            latch.countDown()
        }
        assertTrue("Result received in time", latch.await(3, java.util.concurrent.TimeUnit.SECONDS))
        assertNotNull(result)
        assertEquals(false, result!!["ok"])
        assertEquals("VALIDATION_FAILED", result!!["code"])
        assertEquals("Provider must not be dispatched on decode failure", false, implCalled)
    }

    // ---- W3-3: Stream multiplexing — two consumers, one provider invocation ------

    /**
     * Two consumers subscribe to the same stream+params; assert the provider openStream
     * is called exactly once (not twice) and both consumers receive each emitted item.
     */
    @Ignore("QUARANTINED(WS-5): timing-sensitive under slow CI runners; StreamHub races tracked as RT-AND-03/RT-AND-04 — un-ignore when WS-5 fixes the hub")
    @Test
    fun `W3-3 two consumers same params share one provider invocation`() = runTest {
        var openStreamCallCount = 0
        val received1 = mutableListOf<Map<String, Any?>>()
        val received2 = mutableListOf<Map<String, Any?>>()

        val ticks = listOf(TickStreamValue(10.0), TickStreamValue(20.0))
        val impl = object : HardeningFixture {
            override suspend fun getUserById(params: GetUserByIdParams) =
                GetUserByIdResult("", "", 0.0)
            override fun notify(params: NotifyParams) {}
            override fun tickStream(): Flow<TickStreamValue> {
                openStreamCallCount++
                return kotlinx.coroutines.flow.flowOf(*ticks.toTypedArray())
            }
            override val status = MutableStateFlow("idle")
            override val count = MutableStateFlow(0.0)
        }

        bridgeKit.provide(HardeningFixtureContract, Scope.Global) { impl }

        val env = mapOf(
            "contractId" to "hardening.fixture",
            "member" to "tickStream",
            "scope" to mapOf("kind" to "global"),
            "epoch" to 1,
        )

        val end1Latch = java.util.concurrent.CountDownLatch(1)
        val end2Latch = java.util.concurrent.CountDownLatch(1)

        router.openStream(env = env, onNext = { received1.add(it) }, onEnd = { end1Latch.countDown() })
        router.openStream(env = env, onNext = { received2.add(it) }, onEnd = { end2Latch.countDown() })

        assertTrue("Consumer 1 end received", end1Latch.await(3, java.util.concurrent.TimeUnit.SECONDS))
        assertTrue("Consumer 2 end received", end2Latch.await(3, java.util.concurrent.TimeUnit.SECONDS))

        assertEquals(
            "Provider openStream must be called exactly once (multiplexing)",
            1,
            openStreamCallCount,
        )
        assertEquals("Consumer 1 receives all items", 2, received1.size)
        assertEquals("Consumer 2 receives all items", 2, received2.size)
    }

    /**
     * Two consumers with DIFFERENT params produce TWO separate provider invocations.
     */
    @Ignore(
        "QUARANTINED(WS-5): timing-sensitive under slow CI runners; " +
            "StreamHub races tracked as RT-AND-03/RT-AND-04 - un-ignore when WS-5 fixes the hub"
    )
    @Test
    fun `W3-3 two consumers different params use separate provider invocations`() = runTest {
        var openStreamCallCount = 0
        val impl = object : HardeningFixture {
            override suspend fun getUserById(params: GetUserByIdParams) =
                GetUserByIdResult("", "", 0.0)
            override fun notify(params: NotifyParams) {}
            override fun tickStream(): Flow<TickStreamValue> {
                openStreamCallCount++
                return kotlinx.coroutines.flow.emptyFlow()
            }
            override val status = MutableStateFlow("idle")
            override val count = MutableStateFlow(0.0)
        }

        bridgeKit.provide(HardeningFixtureContract, Scope.Global) { impl }

        val env1 = mapOf(
            "contractId" to "hardening.fixture",
            "member" to "tickStream",
            "scope" to mapOf("kind" to "global"),
            "epoch" to 1,
            "payload" to mapOf("interval" to 1000.0),
        )
        val env2 = mapOf(
            "contractId" to "hardening.fixture",
            "member" to "tickStream",
            "scope" to mapOf("kind" to "global"),
            "epoch" to 1,
            "payload" to mapOf("interval" to 2000.0),
        )

        val end1Latch = java.util.concurrent.CountDownLatch(1)
        val end2Latch = java.util.concurrent.CountDownLatch(1)

        router.openStream(env = env1, onNext = {}, onEnd = { end1Latch.countDown() })
        router.openStream(env = env2, onNext = {}, onEnd = { end2Latch.countDown() })

        assertTrue("Stream 1 ends", end1Latch.await(3, java.util.concurrent.TimeUnit.SECONDS))
        assertTrue("Stream 2 ends", end2Latch.await(3, java.util.concurrent.TimeUnit.SECONDS))

        assertEquals(
            "Different params must produce 2 separate provider invocations",
            2,
            openStreamCallCount,
        )
    }

    // ---- helpers ---------------------------------------------------------------

    private fun fakeImpl(
        onGetUser: ((GetUserByIdParams) -> GetUserByIdResult)? = null,
        onNotify: ((NotifyParams) -> Unit)? = null,
        tickStream: Flow<TickStreamValue> = kotlinx.coroutines.flow.emptyFlow(),
        statusOverride: MutableStateFlow<String>? = null,
    ): HardeningFixture = object : HardeningFixture {
        override suspend fun getUserById(params: GetUserByIdParams): GetUserByIdResult =
            onGetUser?.invoke(params) ?: GetUserByIdResult("", "", 0.0)

        override fun notify(params: NotifyParams) {
            onNotify?.invoke(params)
        }

        override fun tickStream(): Flow<TickStreamValue> = tickStream

        override val status: MutableStateFlow<String> =
            statusOverride ?: MutableStateFlow("idle")

        override val count: MutableStateFlow<Double> =
            MutableStateFlow(0.0)
    }
}
