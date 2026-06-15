package io.github.malopezr7.bridgekit.core

import io.github.malopezr7.bridgekit.runtime.BridgeValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
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
internal class StateStore(
    /**
     * Duration in milliseconds that state entries for a JS-provided contract remain in the
     * [BridgeValue.Replacing] (stale-but-accessible) state during a reconnect grace window
     * before transitioning to [BridgeValue.Unprovided]. 250ms is a placeholder; tune against
     * real reconnect latency on device (design Decision 6).
     */
    internal val replacingGraceMs: Long = 250L,
    /**
     * Coroutine scope used for grace window timers. Defaults to a background scope;
     * injectable for testing (pass a TestScope-backed scope to control time).
     */
    private val graceScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {

    private data class StoreKey(val contractId: String, val stateKey: String, val scopeKey: String)

    // ---- main state map ----------------------------------------------------------

    private val states = ConcurrentHashMap<StoreKey, MutableStateFlow<BridgeValue<Any?>>>()

    private fun getOrCreate(key: StoreKey, initial: BridgeValue<Any?>): MutableStateFlow<BridgeValue<Any?>> =
        states.getOrPut(key) { MutableStateFlow(initial) }

    // ---- grace-window job tracking -----------------------------------------------

    // Tracks active replacing→unprovided timer jobs keyed by StoreKey.toString().
    // Cancelled when the provider re-provisions before the timer fires.
    private val graceJobs = ConcurrentHashMap<String, Job>()

    // ---- observer registry -------------------------------------------------------

    private data class Observer(
        val contractId: String,
        val stateKey: String,
        val scopeKey: String,
        val callback: (Map<String, Any?>) -> Unit,
        val epoch: Long,
    )
    private val observers = ConcurrentHashMap<String, Observer>()
    private val obsCounter = AtomicLong(0)

    // ---- native-provided seeding -------------------------------------------------

    /**
     * Seed the store with initial values for a native-provided contract.
     * Called at provide() time with adapter.stateInitials.
     *
     * Also cancels any active grace-window job for this key so a fast re-provision
     * after a reconnect does not incorrectly expire to Unprovided.
     */
    fun seedNativeState(
        contractId: String,
        scope: Scope,
        stateKey: String,
        initial: Any?,
    ) {
        val key = StoreKey(contractId, stateKey, scope.serialize())
        // Cancel any active replacing→unprovided timer before overwriting with Available.
        graceJobs.remove(key.toString())?.cancel()
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
        // Cancel any active replacing→unprovided timer — JS provider re-provided.
        graceJobs.remove(key.toString())?.cancel()
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
        observers[obsId] = Observer(contractId, stateKey, scope.serialize(), onChange, epoch)
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
        val scopeKey = scope.serialize()
        for ((_, obs) in observers) {
            if (
                obs.contractId != contractId ||
                obs.stateKey != stateKey ||
                obs.scopeKey != scopeKey
            ) {
                continue
            }
            try {
                obs.callback(mapOf("v" to value))
            } catch (_: Exception) {
                // Never let observer failure propagate
            }
        }
    }

    /**
     * H-13: notify observers of a "gone" state (Unprovided / Replacing / grace-expiry).
     * Sends a map WITHOUT the "v" key so that map.v === undefined on the JS side,
     * which triggers the existing stale/unprovided branch in StateMirror._attachObserver.
     * This is ADDITIVE — no new BridgeValue sealed branch is introduced.
     */
    private fun notifyObserversGone(contractId: String, stateKey: String, scope: Scope) {
        val scopeKey = scope.serialize()
        for ((_, obs) in observers) {
            if (
                obs.contractId != contractId ||
                obs.stateKey != stateKey ||
                obs.scopeKey != scopeKey
            ) {
                continue
            }
            try {
                // Omit "v" key — JS onChange(map.v) receives undefined → gone signal.
                obs.callback(mapOf("status" to "gone"))
            } catch (_: Exception) {
                // Never let observer failure propagate
            }
        }
    }

    // ---- unprovide (epoch swap / binding close) --------------------------------

    /**
     * Transition all state entries for a contract+scope to Unprovided.
     * Called when the provider binding is closed or the JS runtime disconnects.
     *
     * H-13: notifyObservers is called after the state transition so JS observers
     * receive an explicit "gone" signal (map without "v" key → map.v === undefined
     * on JS side → stale/unprovided branch in _attachObserver).
     */
    fun markUnprovided(contractId: String, scope: Scope) {
        val scopeKey = scope.serialize()
        for ((key, flow) in states) {
            if (key.contractId == contractId && key.scopeKey == scopeKey) {
                val lastKnown = flow.value.valueOrNull()
                flow.value = BridgeValue.Unprovided(lastKnown)
                // H-13: notify observers — omit "v" key so map.v === undefined in JS.
                notifyObserversGone(contractId, key.stateKey, scope)
            }
        }
    }

    /**
     * Mark ALL JS-provided contract states as Replacing (stale, grace window), then
     * transition to Unprovided after [replacingGraceMs] if no re-provision arrives.
     *
     * Called on epoch swap (connectDispatcher). The grace window prevents a fast OTA
     * swap or StrictMode double-mount from flapping consumers to "not ready" (W2-3).
     *
     * [jsContractIds] is the set of contractIds currently known to be JS-provided.
     */
    fun markJsContractsUnprovided(jsContractIds: Set<String>) {
        for ((key, flow) in states) {
            if (key.contractId !in jsContractIds) continue

            val lastKnown = flow.value.valueOrNull()
            flow.value = BridgeValue.Replacing(lastKnown)

            // H-13: notify observers on Replacing transition.
            // Omit "v" key so map.v === undefined in JS → stale/unprovided branch.
            notifyObserversGone(key.contractId, key.stateKey, Scope.deserialize(key.scopeKey))

            // Cancel any prior grace job for this key before starting a new one.
            val keyStr = key.toString()
            graceJobs.remove(keyStr)?.cancel()

            val job = graceScope.launch {
                delay(replacingGraceMs)
                // Only transition to Unprovided if still in Replacing state.
                // If a re-provision arrived during the window, the flow is now Available
                // and we should NOT overwrite it.
                if (flow.value is BridgeValue.Replacing) {
                    flow.value = BridgeValue.Unprovided(lastKnown)
                    // H-13: notify observers on grace-expiry → Unprovided transition.
                    notifyObserversGone(key.contractId, key.stateKey, Scope.deserialize(key.scopeKey))
                }
                graceJobs.remove(keyStr)
            }
            graceJobs[keyStr] = job
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
