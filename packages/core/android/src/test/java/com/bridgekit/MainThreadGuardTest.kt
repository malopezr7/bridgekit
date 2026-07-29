package com.bridgekit

import com.bridgekit.core.MainThreadChecker
import com.bridgekit.core.OutboundCallerImpl
import com.bridgekit.core.ParkBuffer
import com.bridgekit.core.Router
import com.bridgekit.core.Scope
import com.bridgekit.core.StateStore
import com.bridgekit.runtime.JsDispatcherCallbacks
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * RT-AND-09: the main-thread guard rejected the canonical Android call site.
 *
 * `invoke` and `awaitDispatcher` are both `suspend` functions. A suspend function
 * running on `Dispatchers.Main` does not block the main thread — it suspends and
 * yields it, which is the entire point of coroutines. Neither can cause an ANR,
 * and the one genuinely blocking entry point, `invokeSync`, throws
 * `UnsupportedOperationException` for JS-provided contracts, so there is nothing
 * on this class to protect.
 *
 * The guard nevertheless fired unconditionally at entry, so
 * `lifecycleScope.launch { client.foo() }` — the canonical Android usage, which
 * runs on `Dispatchers.Main` — always threw. All three example apps work around
 * it with `CoroutineScope(SupervisorJob() + Dispatchers.Default)`, and every
 * existing unit test injects `MainThreadChecker { false }` to get past it.
 *
 * It also threw a raw `IllegalStateException` rather than a `BridgeKitException`,
 * so it escaped the typed error envelope entirely. iOS has no equivalent guard,
 * so the same contract behaved differently per platform.
 */
class MainThreadGuardTest {

    private fun routerWithDispatcher(result: Map<String, Any?>): Router {
        val router = Router(StateStore(), ParkBuffer(), readinessTimeoutMs = 100, callTimeoutMs = 500)
        router.connectDispatcher(
            epochInfo = emptyMap(),
            callbacks = JsDispatcherCallbacks(
                onInvoke = { _, complete -> complete(result, null) },
                onStreamOpen = {},
                onStreamClose = {},
                onStateWrite = {},
            ),
        )
        return router
    }

    /** MainThreadChecker { true } models `lifecycleScope.launch { ... }`. */
    private fun callerOnMainThread(router: Router) =
        OutboundCallerImpl(
            contractId = "test.mainthread",
            scope = Scope.Global,
            router = router,
            mainThreadChecker = MainThreadChecker { true },
            readinessTimeoutMs = 100,
            callTimeoutMs = 500,
        )

    @Test
    fun `invoke from the main thread is allowed because suspend does not block it`() = runTest {
        val router = routerWithDispatcher(mapOf("ok" to true, "value" to "pong"))
        val caller = callerOnMainThread(router)

        val result = withTimeout(2_000) { caller.invoke("ping", null) }

        assertEquals("pong", result)
    }

    @Test
    fun `awaiting the dispatcher from the main thread is allowed`() = runTest {
        // No dispatcher connected yet: invoke must park in awaitDispatcher rather
        // than reject the caller for being on the main thread.
        val router = Router(StateStore(), ParkBuffer(), readinessTimeoutMs = 100, callTimeoutMs = 500)
        val caller = callerOnMainThread(router)

        val error = runCatching { withTimeout(2_000) { caller.invoke("ping", null) } }.exceptionOrNull()

        // It should fail on readiness, not on which thread the caller is using.
        assertEquals(
            "the main-thread guard rejected the call instead of parking for the dispatcher",
            false,
            error is IllegalStateException,
        )
    }

    @Test
    fun `invokeSync remains unsupported for JS-provided contracts`() {
        val router = routerWithDispatcher(mapOf("ok" to true))
        val caller = callerOnMainThread(router)

        val error = runCatching { caller.invokeSync("ping", null) }.exceptionOrNull()

        assertEquals(true, error is UnsupportedOperationException)
    }
}
