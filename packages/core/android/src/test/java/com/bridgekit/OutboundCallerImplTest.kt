package com.bridgekit

import com.bridgekit.core.MainThreadChecker
import com.bridgekit.core.OutboundCallerImpl
import com.bridgekit.core.ParkBuffer
import com.bridgekit.core.Router
import com.bridgekit.core.Scope
import com.bridgekit.core.StateStore
import com.bridgekit.runtime.JsDispatcherCallbacks
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

class OutboundCallerImplTest {

    @Test
    fun `stream close signals JS when collector cancels`() = runTest {
        val router = Router(StateStore(), ParkBuffer(), readinessTimeoutMs = 100, callTimeoutMs = 500)
        val opened = CompletableDeferred<String>()
        val closed = CompletableDeferred<Map<String, Any?>>()

        router.connectDispatcher(
            epochInfo = emptyMap(),
            callbacks = JsDispatcherCallbacks(
                onInvoke = { _, complete -> complete(mapOf("ok" to true), null) },
                onStreamOpen = { env -> opened.complete(env["streamId"] as String) },
                onStreamClose = { env -> closed.complete(env) },
                onStateWrite = {},
            ),
        )

        val caller = OutboundCallerImpl(
            contractId = "test.stream",
            scope = Scope.Global,
            router = router,
            mainThreadChecker = MainThreadChecker { false },
            readinessTimeoutMs = 100,
            callTimeoutMs = 500,
        )

        val job = launch { caller.stream("ticks", null).collect() }
        val streamId = withTimeout(1_000) { opened.await() }

        job.cancelAndJoin()

        val closeEnv = withTimeout(1_000) { closed.await() }
        assertEquals(streamId, closeEnv["streamId"])
        assertEquals("native-close", closeEnv["reason"])
    }

    @Test
    fun `stream completes when JS sends end envelope`() = runTest {
        val router = Router(StateStore(), ParkBuffer(), readinessTimeoutMs = 100, callTimeoutMs = 500)
        val opened = CompletableDeferred<String>()

        router.connectDispatcher(
            epochInfo = emptyMap(),
            callbacks = JsDispatcherCallbacks(
                onInvoke = { _, complete -> complete(mapOf("ok" to true), null) },
                onStreamOpen = { env -> opened.complete(env["streamId"] as String) },
                onStreamClose = {},
                onStateWrite = {},
            ),
        )

        val caller = OutboundCallerImpl(
            contractId = "test.stream",
            scope = Scope.Global,
            router = router,
            mainThreadChecker = MainThreadChecker { false },
            readinessTimeoutMs = 100,
            callTimeoutMs = 500,
        )

        val values = mutableListOf<Any?>()
        val job = launch { caller.stream("ticks", null).toList(values) }
        val streamId = withTimeout(1_000) { opened.await() }

        router.emitFromJs(streamId, mapOf("v" to 1.0))
        router.endFromJs(streamId, mapOf("ok" to true))

        withTimeout(1_000) { job.join() }
        assertEquals(listOf(1.0), values)
    }
}
