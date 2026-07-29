package com.bridgekit.core

import android.os.Looper

/**
 * Abstraction over main-thread detection.
 * Default implementation uses Android's Looper; tests inject a fake.
 *
 * DO NOT apply this to `suspend` functions.
 *
 * It was previously used to reject `invoke` and `awaitDispatcher` when called
 * from the main thread, on ANR grounds. Both are suspend functions: running them
 * on `Dispatchers.Main` yields the thread instead of blocking it, which is the
 * entire point of coroutines, so neither can cause an ANR. What the guard did
 * cause was the rejection of `lifecycleScope.launch { client.foo() }` — the
 * canonical Android call site — with a raw `IllegalStateException` outside the
 * typed error envelope, and with no iOS equivalent. All three example apps
 * worked around it with a `Dispatchers.Default` scope.
 *
 * It is retained for a genuinely blocking entry point, should one ever exist.
 * `OutboundCallerImpl.invokeSync` is not one: it throws
 * `UnsupportedOperationException`, because JS cannot be called synchronously
 * from native.
 */
fun interface MainThreadChecker {
    fun isMainThread(): Boolean
}

/**
 * Production implementation: Looper.getMainLooper().isCurrentThread.
 */
val AndroidMainThreadChecker: MainThreadChecker = MainThreadChecker {
    Looper.getMainLooper().isCurrentThread
}
