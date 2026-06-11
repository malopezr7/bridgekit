package io.github.malopezr7.bridgekit.core

import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Park buffer for ops arriving before a contract is provided.
 *
 * When a native consume-side call arrives and no binding exists, the call is parked
 * here (bounded to [MAX_PARKED] per contract+scope) until either:
 *  - the contract is provided → the waiting coroutines are unparked and routed
 *  - the readiness timeout fires → CONTRACT_NOT_PROVIDED
 *
 * Also used to re-park durable interests (native consume subscriptions to JS streams
 * and state observations) across epoch swaps.
 */
internal class ParkBuffer {

    companion object {
        const val MAX_PARKED = 64
    }

    private data class ParkKey(val contractId: String, val scopeKey: String)

    // Deferred signals for waiting coroutines: true = provided, false = failed
    private val waiters = ConcurrentHashMap<ParkKey, CopyOnWriteArrayList<CompletableDeferred<Boolean>>>()

    /**
     * Register a waiter for (contractId, scope).
     * Returns a [CompletableDeferred] that completes true when the contract is provided,
     * or false when the caller should fail.
     *
     * If the buffer is already full, returns null (caller should fail immediately).
     */
    fun park(contractId: String, scope: Scope): CompletableDeferred<Boolean>? {
        val key = ParkKey(contractId, scope.serialize())
        val list = waiters.getOrPut(key) { CopyOnWriteArrayList() }
        if (list.size >= MAX_PARKED) return null
        val deferred = CompletableDeferred<Boolean>()
        list.add(deferred)
        return deferred
    }

    /**
     * Unpark all waiters for (contractId, scope) — called when a binding is provided.
     * Completes each waiting deferred with true.
     */
    fun unpark(contractId: String, scope: Scope) {
        val key = ParkKey(contractId, scope.serialize())
        val list = waiters.remove(key) ?: return
        for (deferred in list) {
            deferred.complete(true)
        }
    }

    /**
     * Fail all waiters for (contractId, scope) with false — called on timeout or close.
     */
    fun failAll(contractId: String, scope: Scope) {
        val key = ParkKey(contractId, scope.serialize())
        val list = waiters.remove(key) ?: return
        for (deferred in list) {
            deferred.complete(false)
        }
    }

    /**
     * Fail all parked ops across all contracts — called during epoch swap for native→JS direction.
     */
    fun failAllPending() {
        for ((_, list) in waiters) {
            for (deferred in list) {
                deferred.complete(false)
            }
        }
        waiters.clear()
    }

    fun dump(): String {
        val entries = waiters.entries.filter { it.value.isNotEmpty() }
        if (entries.isEmpty()) return "parked=0"
        return entries.joinToString(separator = "\n") { (k, v) ->
            "parked|${k.contractId}|${k.scopeKey}|count=${v.size}"
        }
    }
}
