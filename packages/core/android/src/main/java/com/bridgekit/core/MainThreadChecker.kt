package com.bridgekit.core

import android.os.Looper

/**
 * Abstraction over main-thread detection.
 * Default implementation uses Android's Looper; tests inject a fake.
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
