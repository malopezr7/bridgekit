package io.github.malopezr7.bridgekit.core

import io.github.malopezr7.bridgekit.runtime.BridgeValue
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Bidirectional state store.
 *
 * Keyed by (contractId, stateKey, scopeKey). Holds:
 *  - The current [BridgeValue<Any?>] as a [MutableStateFlow] (epoch-tagged).
 *  - A set of native observer callbacks (registered via stateObserve from JS).
 *
 * Native-provided contracts: engine seeds from adapter.stateInitials and subscribes to
 * each provider stateFlow (via [seedNativeState] + [linkProviderFlow]).
 * JS-provided contracts: engine writes via [write] when stateWrite arrives.
 *
 * Observers (obsId → callback) are epoch-tagged; stale-epoch callbacks are dropped on invoke.
 */
internal class StateStore {

    private data class StoreKey(val contractId: String, val stateKey: String, val scopeKey: String)

    // ---- main state map ----------------------------------------------------------

    private val states = ConcurrentHashMap<StoreKey, MutableStateFlow<BridgeValue<Any?>>>()

    private fun getOrCreate(key: StoreKey, initial: BridgeValue<Any?>): MutableStateFlow<BridgeValue<Any?>> =
        states.getOrPut(key) { MutableStateFlow(initial) }

    // ---- observer registry -------------------------------------------------------

    private data class Observer(val callback: (Map<String, Any?>) -> Unit, val epoch: Long)
    private val observers = ConcurrentHashMap<String, Observer>()
    private val obsCounter = AtomicLong(0)

    // ---- native-provided seeding -------------------------------------------------

    /**
     * Seed the store with initial values for a native-provided contract.
     * Called at provide() time with adapter.stateInitials.
     */
    fun seedNativeState(
        contractId: String,
        scope: Scope,
        stateKey: String,
        initial: Any?,
    ) {
        val key = StoreKey(contractId, stateKey, scope.serialize())
        val flow = getOrCreate(key, BridgeValue.Initial(initial))
        flow.value = BridgeValue.Available(initial)
    }

    /**
     * Update a native state entry (called when a provider MutableStateFlow emits).
     */
    fun setNativeValue(contractId: String, scope: Scope, stateKey: String, value: Any?) {
        val key = StoreKey(contractId, stateKey, scope.serialize())
        val flow = getOrCreate(key, BridgeValue.Available(value))
        flow.value = BridgeValue.Available(value)
        notifyObservers(contractId, stateKey, scope, value)
    }

    // ---- JS-provided writes -----------------------------------------------------

    /**
     * Write a state value from the JS side (stateWrite envelope).
     * Returns { ok: true } or { ok: false, code: NOT_PROVIDER } if the native side owns this binding.
     */
    fun writeFromJs(
        contractId: String,
        scope: Scope,
        stateKey: String,
        value: Any?,
        nativeOwnsBinding: Boolean,
    ): Map<String, Any?> {
        if (nativeOwnsBinding) {
            return mapOf(
                "ok" to false,
                "code" to "NOT_PROVIDER",
                "message" to "Native side owns binding for '$contractId'; JS cannot write state",
                "contractId" to contractId,
            )
        }
        val key = StoreKey(contractId, stateKey, scope.serialize())
        val flow = getOrCreate(key, BridgeValue.Available(value))
        flow.value = BridgeValue.Available(value)
        notifyObservers(contractId, stateKey, scope, value)
        return mapOf("ok" to true, "value" to mapOf("v" to value))
    }

    // ---- reads ------------------------------------------------------------------

    fun read(contractId: String, scope: Scope, stateKey: String, initial: Any?): BridgeValue<Any?> {
        val key = StoreKey(contractId, stateKey, scope.serialize())
        return states[key]?.value ?: BridgeValue.Initial(initial)
    }

    fun getFlow(contractId: String, scope: Scope, stateKey: String, initial: Any?): StateFlow<BridgeValue<Any?>> {
        val key = StoreKey(contractId, stateKey, scope.serialize())
        return getOrCreate(key, BridgeValue.Initial(initial))
    }

    // ---- observers -------------------------------------------------------------

    fun observe(
        contractId: String,
        scope: Scope,
        stateKey: String,
        epoch: Long,
        onChange: (Map<String, Any?>) -> Unit,
    ): String {
        val obsId = "obs_${obsCounter.incrementAndGet()}"
        observers[obsId] = Observer(onChange, epoch)
        return obsId
    }

    fun unobserve(obsId: String) {
        observers.remove(obsId)
    }

    /**
     * Remove all observers registered for a given epoch (called on epoch swap).
     */
    fun clearObserversForEpoch(epoch: Long) {
        observers.entries.removeIf { it.value.epoch == epoch }
    }

    private fun notifyObservers(contractId: String, stateKey: String, scope: Scope, value: Any?) {
        for ((_, obs) in observers) {
            try {
                obs.callback(mapOf("v" to value))
            } catch (_: Exception) {
                // Never let observer failure propagate
            }
        }
    }

    // ---- unprovide (epoch swap / binding close) --------------------------------

    /**
     * Transition all state entries for a contract+scope to Unprovided.
     * Called when the provider binding is closed or the JS runtime disconnects.
     */
    fun markUnprovided(contractId: String, scope: Scope) {
        val scopeKey = scope.serialize()
        for ((key, flow) in states) {
            if (key.contractId == contractId && key.scopeKey == scopeKey) {
                val lastKnown = flow.value.valueOrNull()
                flow.value = BridgeValue.Unprovided(lastKnown)
            }
        }
    }

    /**
     * Mark ALL JS-provided contract states as Unprovided (called on epoch swap).
     * [jsContractIds] is the set of contractIds currently known to be JS-provided.
     */
    fun markJsContractsUnprovided(jsContractIds: Set<String>) {
        for ((key, flow) in states) {
            if (key.contractId in jsContractIds) {
                val lastKnown = flow.value.valueOrNull()
                flow.value = BridgeValue.Unprovided(lastKnown)
            }
        }
    }

    // ---- dump ------------------------------------------------------------------

    fun dump(): String = buildString {
        for ((key, flow) in states.entries.sortedBy { it.key.toString() }) {
            appendLine("state|${key.contractId}|${key.stateKey}|${key.scopeKey}|${flow.value}")
        }
        append("observers=${observers.size}")
    }
}
