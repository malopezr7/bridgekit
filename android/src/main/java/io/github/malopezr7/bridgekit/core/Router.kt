package io.github.malopezr7.bridgekit.core

import io.github.malopezr7.bridgekit.diagnostics.BridgeKitDiagnostics
import io.github.malopezr7.bridgekit.runtime.BridgeContractDefinition
import io.github.malopezr7.bridgekit.runtime.JsDispatcherCallbacks
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.onFailure
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

// W3-3 helper: deterministic params hash for StreamHub keying.
// Uses sorted key order so params with the same entries in different order hash the same.
private fun paramsHash(payload: Map<String, Any?>?): Long {
    if (payload == null || payload.isEmpty()) return 0L
    var h = 0x811c9dc5L
    for (key in payload.keys.sorted()) {
        val v = payload[key]
        val entry = "$key=${v}"
        for (c in entry) {
            h = h xor c.code.toLong()
            h = (h * 0x01000193L) and 0xFFFFFFFFL
        }
    }
    return h
}

/**
 * BridgeKit routing engine. Implements [BridgeKitNativeDelegate] and installs itself
 * into [io.github.malopezr7.bridgekit.runtime.BridgeKitNative.delegate].
 *
 * Thread safety: all mutable state is guarded by [lock] except [epoch] (AtomicLong)
 * and [stateStore] (internally concurrent). Callback invocations happen on
 * Dispatchers.Default coroutines; JS callbacks are dispatched on the JS thread by Nitro.
 */
internal class Router(
    internal val stateStore: StateStore,
    private val parkBuffer: ParkBuffer,
    private val diagnostics: BridgeKitDiagnostics = BridgeKitDiagnostics,
    internal val readinessTimeoutMs: Long = 5_000,
    internal val callTimeoutMs: Long = 30_000,
    /**
     * Wire hash skew enforcement (design Decision 2, three-stage rollout).
     *   false (default) = OBSERVE: log mismatches via diagnostics, NEVER reject — the
     *     live demo keeps working before on-device hash-parity verification.
     *   true = ENFORCE: return INCOMPATIBLE_CONTRACT on mismatch without dispatching.
     * The final flip to true is gated on real-device verification (out of scope here).
     */
    internal val strictHashCheck: Boolean = false,
) : io.github.malopezr7.bridgekit.runtime.BridgeKitNativeDelegate {

    private val lock = Any()

    // ---- binding registry -------------------------------------------------------

    // (contractId, scopeKey) → BindingEntry
    private val bindings = ConcurrentHashMap<String, BindingEntry>()
    private fun bindingKey(contractId: String, scope: Scope) = "$contractId|${scope.serialize()}"

    // ---- epoch ------------------------------------------------------------------

    private val epochCounter = AtomicLong(0)
    private val epoch: Long get() = epochCounter.get()

    // ---- JS dispatcher ----------------------------------------------------------

    @Volatile
    private var jsCallbacks: JsDispatcherCallbacks? = null

    // ---- JS-consume stream tracking (native consumes JS-provided streams) -------

    private val jsStreamJobs = ConcurrentHashMap<String, Job>()
    private val jsStreamIdCounter = AtomicLong(0)

    // ---- stream pump tracking (native-provided → JS) ----------------------------

    private val streamPumpJobs = ConcurrentHashMap<String, Pair<Long, Job>>() // streamId → (epoch, job)

    // coroutine scope for all stream pumps + state observations
    private var engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // W3-3: StreamHub — multiplexes provider Flows across N consumers with same params.
    private var streamHub = StreamHub(engineScope)

    // ---- JS-provided contract set (for epoch-swap markings) --------------------

    private val jsProvidedContracts = ConcurrentHashMap.newKeySet<String>()

    // ============================================================================
    // BridgeKitNativeDelegate implementation
    // ============================================================================

    override fun invoke(env: Map<String, Any?>, complete: (Map<String, Any?>) -> Unit) {
        val contractId = env["contractId"] as? String ?: return complete(errEnv("CONTRACT_NOT_PROVIDED", "Missing contractId"))
        val member = env["member"] as? String ?: return complete(errEnv("METHOD_NOT_FOUND", "Missing member"))
        val scope = parseScopeEnv(env)
        val epochEnv = (env["epoch"] as? Number)?.toLong() ?: 0L
        val correlationId = env["correlationId"] as? String ?: ""
        val payload = extractPayload(env)

        val t0 = System.currentTimeMillis()
        val currentEpoch = epoch

        engineScope.launch {
            val result = invokeWithReadiness(contractId, scope, member, payload, epochEnv, currentEpoch, correlationId, env)
            val dur = System.currentTimeMillis() - t0
            diagnostics.trace("invoke", contractId, member, scope.serialize(), if (result["ok"] == true) "OK" else (result["code"] as? String ?: "ERR"), dur, currentEpoch)
            complete(result)
        }
    }

    override fun invokeSync(env: Map<String, Any?>): Map<String, Any?> {
        val contractId = env["contractId"] as? String ?: return errEnv("CONTRACT_NOT_PROVIDED", "Missing contractId")
        val member = env["member"] as? String ?: return errEnv("METHOD_NOT_FOUND", "Missing member")
        val scope = parseScopeEnv(env)
        val payload = extractPayload(env)

        val binding = resolveBinding(contractId, scope)
            ?: return errEnv("CONTRACT_NOT_PROVIDED", "Contract '$contractId' not provided in scope ${scope.serialize()}", contractId, member, scope)

        // Wire hash skew check before dispatch (enforced only in strict mode).
        checkContractHash(contractId, member, scope, binding, env)?.let { return it }

        return try {
            val result = binding.adapter.invokeSync(member, payload)
            okEnv(result)
        } catch (e: io.github.malopezr7.bridgekit.runtime.BridgeKitDecodeException) {
            errEnv("VALIDATION_FAILED", "Decode failed for '$member' on '$contractId': ${e.message}", contractId, member, scope)
        } catch (e: IllegalArgumentException) {
            errEnv("METHOD_NOT_FOUND", "No sync method '$member' in contract '$contractId': ${e.message}", contractId, member, scope)
        } catch (e: Exception) {
            errEnv("PROVIDER_ERROR", "Sync call failed: ${e.message}", contractId, member, scope)
        }
    }

    override fun connectDispatcher(
        epochInfo: Map<String, Any?>,
        callbacks: JsDispatcherCallbacks,
    ): Map<String, Any?> {
        val newEpoch = epochCounter.incrementAndGet()

        synchronized(lock) {
            // 1. Cancel prior-epoch stream pump jobs + StreamHub (W3-3)
            val priorEpochJobs = streamPumpJobs.values.filter { it.first < newEpoch }
            for ((_, job) in priorEpochJobs) job.cancel("Epoch swap: prior epoch $newEpoch")
            streamPumpJobs.entries.removeIf { it.value.first < newEpoch }
            streamHub.cancelAll()
            // Recreate streamHub with the current engineScope for the new epoch
            streamHub = StreamHub(engineScope)

            // 2. Cancel prior-epoch JS-consume stream jobs
            for (job in jsStreamJobs.values) job.cancel("Epoch swap $newEpoch")
            jsStreamJobs.clear()

            // 3. Fail in-flight native→JS calls (park buffer for JS-provided)
            parkBuffer.failAllPending()

            // 4. Mark all JS-provided contracts unprovided + clear state
            stateStore.markJsContractsUnprovided(jsProvidedContracts.toSet())

            // 5. Remove stale state observers for previous epoch
            stateStore.clearObserversForEpoch(newEpoch - 1)

            // 6. Install new dispatcher
            jsCallbacks = callbacks
        }

        // Build state snapshot of all native-provided state entries
        val snapshot = buildNativeStateSnapshot()

        diagnostics.trace("connectDispatcher", "engine", epoch = newEpoch)
        return mapOf(
            "epoch" to newEpoch,
            "snapshot" to snapshot,
        )
    }

    override fun openStream(
        env: Map<String, Any?>,
        onNext: (Map<String, Any?>) -> Unit,
        onEnd: (Map<String, Any?>) -> Unit,
    ): String {
        val contractId = env["contractId"] as? String ?: run {
            onEnd(errEnv("CONTRACT_NOT_PROVIDED", "Missing contractId"))
            return ""
        }
        val member = env["member"] as? String ?: run {
            onEnd(errEnv("METHOD_NOT_FOUND", "Missing member"))
            return ""
        }
        val scope = parseScopeEnv(env)
        val streamEpoch = (env["epoch"] as? Number)?.toLong() ?: epoch
        val payload = extractPayload(env)

        val binding = resolveBinding(contractId, scope) ?: run {
            onEnd(errEnv("CONTRACT_NOT_PROVIDED", "Contract '$contractId' not provided", contractId, member, scope))
            return ""
        }

        // Wire hash skew check before opening the stream (enforced only in strict mode).
        checkContractHash(contractId, member, scope, binding, env)?.let {
            onEnd(it)
            return ""
        }

        // W3-3: Multiplex consumers of the same provider+params through StreamHub.
        // This replaces the per-call Flow creation with a shared Flow fan-out.
        val pHash = paramsHash(payload)
        val streamId = "${contractId}_${member}_${pHash}_${System.nanoTime()}"

        val job = streamHub.attach(
            contractId = contractId,
            member = member,
            scope = scope,
            paramsHash = pHash,
            adapter = binding.adapter,
            payload = payload,
            streamEpoch = streamEpoch,
            streamId = streamId,
            onNext = onNext,
            onEnd = { endEnv ->
                streamPumpJobs.remove(streamId)
                onEnd(endEnv)
            },
        )

        streamPumpJobs[streamId] = Pair(streamEpoch, job)
        binding.registerStreamJob(streamId, job)

        diagnostics.trace("openStream", contractId, member, scope.serialize(), epoch = streamEpoch)
        return streamId
    }

    override fun closeStream(streamId: String) {
        val (_, job) = streamPumpJobs.remove(streamId) ?: return
        job.cancel("closeStream by JS")
        diagnostics.trace("closeStream", streamId)
    }

    override fun emitFromJs(streamId: String, value: Map<String, Any?>) {
        // Route into the JS→native stream channel
        val channel = jsStreamChannels[streamId] ?: return // logged no-op
        val result = channel.trySend(value)
        result.onFailure {
            diagnostics.recordDrop()
            diagnostics.trace("emitFromJs_drop", streamId, code = "BUFFER_FULL")
        }
    }

    override fun endFromJs(streamId: String, end: Map<String, Any?>) {
        jsStreamEnds[streamId]?.complete(end)
    }

    override fun stateRead(env: Map<String, Any?>): Map<String, Any?> {
        val contractId = env["contractId"] as? String ?: return errEnv("CONTRACT_NOT_PROVIDED", "Missing contractId")
        val stateKey = env["member"] as? String ?: return errEnv("VALIDATION_FAILED", "Missing member/stateKey")
        val scope = parseScopeEnv(env)

        val value = stateStore.read(contractId, scope, stateKey, null)
        return okEnv(mapOf("v" to value.valueOrNull()))
    }

    override fun stateObserve(env: Map<String, Any?>, onChange: (Map<String, Any?>) -> Unit): String {
        val contractId = env["contractId"] as? String ?: return ""
        val stateKey = env["member"] as? String ?: return ""
        val scope = parseScopeEnv(env)

        return stateStore.observe(contractId, scope, stateKey, epoch, onChange)
    }

    override fun stateUnobserve(obsId: String) {
        stateStore.unobserve(obsId)
    }

    override fun stateWrite(env: Map<String, Any?>): Map<String, Any?> {
        val contractId = env["contractId"] as? String ?: return errEnv("CONTRACT_NOT_PROVIDED", "Missing contractId")
        val stateKey = env["member"] as? String ?: return errEnv("VALIDATION_FAILED", "Missing member/stateKey")
        val scope = parseScopeEnv(env)
        val valueWrapped = env["payload"] as? Map<*, *>
        @Suppress("UNCHECKED_CAST")
        val value = (valueWrapped as? Map<String, Any?>)?.get("v")

        // Check if native side owns this binding.
        val nativeOwns = resolveBinding(contractId, scope) != null
        if (!nativeOwns) {
            // A stateWrite for a contract native does NOT own ⇒ JS is the provider.
            // Record it so isProvided / awaitProvided / tryConsume are truthful for
            // JS-provided contracts. Also unpark any native-side awaitProvided waiters.
            // ADR-5: markJsProvided is the real JS-provide path signal.
            // Accepted limitation: stateless JS contracts emit no stateWrite, so they
            // won't be marked here — noted follow-up (ADR-5 edge case).
            markJsProvided(contractId)
            parkBuffer.unpark(contractId, scope)
        }
        return stateStore.writeFromJs(contractId, scope, stateKey, value, nativeOwns)
    }

    // ============================================================================
    // Internal API (used by BridgeKit)
    // ============================================================================

    /**
     * Register a native provider binding. Returns the BindingEntry.
     * If a binding already exists for (contractId, scope), it is closed with Replacing
     * and replaced.
     */
    internal fun registerBinding(entry: BindingEntry) {
        val key = bindingKey(entry.contractId, entry.scope)
        val previous = bindings.put(key, entry)
        if (previous != null && previous.isLive) {
            previous.close(CloseReason.Replacing)
            // Unpark waiters after a brief grace (handled by consumers via retry after replace)
        }
        // Seed state store with initial values
        for ((stateKey, initial) in entry.adapter.stateInitials) {
            stateStore.seedNativeState(entry.contractId, entry.scope, stateKey, initial)
        }
        // Subscribe to each provider state flow for change propagation
        for ((stateKey, stateFlow) in entry.adapter.stateFlows()) {
            val collectJob = engineScope.launch {
                stateFlow.collect { value ->
                    stateStore.setNativeValue(entry.contractId, entry.scope, stateKey, value)
                }
            }
            entry.bindingScope.coroutineContext[Job]?.invokeOnCompletion { collectJob.cancel() }
        }
        // Unpark any waiting consumers
        parkBuffer.unpark(entry.contractId, entry.scope)
        diagnostics.trace("provide", entry.contractId, scope = entry.scope.serialize(), epoch = epoch)
    }

    /**
     * Resolve binding with instance→feature→global fallback.
     */
    internal fun resolveBinding(contractId: String, scope: Scope): BindingEntry? {
        if (scope is Scope.Instance) {
            bindings[bindingKey(contractId, scope)]?.let { return it }
            bindings[bindingKey(contractId, Scope.Feature(scope.feature))]?.let { return it }
        } else if (scope is Scope.Feature) {
            bindings[bindingKey(contractId, scope)]?.let { return it }
        }
        return bindings[bindingKey(contractId, Scope.Global)]
    }

    /**
     * Remove a binding. Called by Binding.close().
     */
    internal fun removeBinding(entry: BindingEntry) {
        val key = bindingKey(entry.contractId, entry.scope)
        bindings.remove(key, entry)
        stateStore.markUnprovided(entry.contractId, entry.scope)
        entry.cancelAllStreamJobs()
    }

    /**
     * Await until (contractId, scope) is provided, with timeout.
     * Returns true if provided, false if timed out.
     * ADR-5: also returns true immediately for JS-provided contracts (jsProvidedContracts set).
     */
    internal suspend fun awaitProvided(contractId: String, scope: Scope, timeoutMs: Long): Boolean {
        if (resolveBinding(contractId, scope) != null) return true
        if (jsProvidedContracts.contains(contractId)) return true
        val deferred = parkBuffer.park(contractId, scope) ?: return false
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (_: TimeoutCancellationException) {
            false
        }
    }

    /**
     * Is the contract currently provided?
     * Returns true for both native-registered bindings and JS-provided contracts
     * (tracked via markJsProvided when JS calls provide() on the JS registry).
     */
    internal fun isProvided(contractId: String, scope: Scope): Boolean =
        resolveBinding(contractId, scope) != null || jsProvidedContracts.contains(contractId)

    /**
     * Return the current epoch.
     */
    internal fun currentEpoch(): Long = epoch

    /**
     * Track a JS-provided contract id (arrives when JS calls provide on the JS registry).
     * This is registered implicitly when a JS-directed invoke/stream/stateWrite arrives.
     */
    internal fun markJsProvided(contractId: String) {
        jsProvidedContracts.add(contractId)
    }

    internal fun getJsCallbacks(): JsDispatcherCallbacks? = jsCallbacks

    // ---- JS→native stream channels (for consume-side flow) ---------------------

    internal val jsStreamChannels = ConcurrentHashMap<String, Channel<Map<String, Any?>>>()
    internal val jsStreamEnds = ConcurrentHashMap<String, kotlinx.coroutines.CompletableDeferred<Map<String, Any?>>>()

    // ============================================================================
    // Private helpers
    // ============================================================================

    private suspend fun invokeWithReadiness(
        contractId: String,
        scope: Scope,
        member: String,
        payload: Map<String, Any?>?,
        epochEnv: Long,
        currentEpoch: Long,
        correlationId: String,
        env: Map<String, Any?>,
    ): Map<String, Any?> {
        var binding = resolveBinding(contractId, scope)

        if (binding == null) {
            val provided = awaitProvided(contractId, scope, readinessTimeoutMs)
            if (!provided) {
                return errEnv(
                    "CONTRACT_NOT_PROVIDED",
                    "Contract '$contractId' not provided in scope ${scope.serialize()} after ${readinessTimeoutMs}ms",
                    contractId, member, scope,
                )
            }
            binding = resolveBinding(contractId, scope)
                ?: return errEnv("CONTRACT_NOT_PROVIDED", "Contract '$contractId' vanished after park", contractId, member, scope)
        }

        // Wire hash skew check before dispatch (enforced only in strict mode).
        checkContractHash(contractId, member, scope, binding, env)?.let { return it }

        return try {
            val result = withTimeout(callTimeoutMs) {
                binding.adapter.invoke(member, payload)
            }
            okEnv(result)
        } catch (e: TimeoutCancellationException) {
            errEnv("TIMEOUT", "Call to '$member' on '$contractId' timed out after ${callTimeoutMs}ms", contractId, member, scope)
        } catch (e: io.github.malopezr7.bridgekit.runtime.BridgeKitDecodeException) {
            errEnv("VALIDATION_FAILED", "Decode failed for '$member' on '$contractId': ${e.message}", contractId, member, scope)
        } catch (e: IllegalArgumentException) {
            errEnv("METHOD_NOT_FOUND", "Unknown member '$member' on '$contractId': ${e.message}", contractId, member, scope)
        } catch (e: Exception) {
            errEnv("PROVIDER_ERROR", "${e.javaClass.simpleName}: ${e.message}", contractId, member, scope)
        }
    }

    private fun buildNativeStateSnapshot(): List<Map<String, Any?>> {
        val snapshot = mutableListOf<Map<String, Any?>>()
        for ((_, entry) in bindings) {
            if (!entry.isLive) continue
            for ((stateKey, _) in entry.adapter.stateInitials) {
                val bv = stateStore.read(entry.contractId, entry.scope, stateKey, null)
                val value = bv.valueOrNull()
                snapshot.add(mapOf(
                    "contractId" to entry.contractId,
                    "key" to stateKey,
                    "scope" to scopeToEnvMap(entry.scope),
                    "v" to value,
                ))
            }
        }
        return snapshot
    }

    internal fun dump(): String = buildString {
        appendLine("epoch=$epoch bindings=${bindings.size} streamPumps=${streamPumpJobs.size}")
        for ((key, entry) in bindings) {
            appendLine("binding|$key|live=${entry.isLive}")
        }
        appendLine(parkBuffer.dump())
        appendLine(stateStore.dump())
        appendLine(diagnostics.dumpCounters())
    }

    // ============================================================================
    // Envelope helpers
    // ============================================================================

    private fun parseScopeEnv(env: Map<String, Any?>): Scope {
        val scopeObj = env["scope"] as? Map<*, *> ?: return Scope.Global
        @Suppress("UNCHECKED_CAST")
        return Scope.fromEnvelopeMap(scopeObj as Map<String, Any?>)
    }

    private fun extractPayload(env: Map<String, Any?>): Map<String, Any?>? {
        val p = env["payload"] ?: return null
        @Suppress("UNCHECKED_CAST")
        return p as? Map<String, Any?>
    }

    /**
     * Wire hash skew check (design Decision 2). Compares the caller's envelope
     * contractHash against the native binding's generated contractHash.
     *
     * Returns an INCOMPATIBLE_CONTRACT error envelope ONLY when [strictHashCheck]
     * is enabled AND the hashes both exist and differ. In observe mode (default) or
     * when either hash is absent (legacy schema-less contract / loopback), it records
     * the skew for diagnostics and returns null so the call dispatches normally.
     */
    private fun checkContractHash(
        contractId: String,
        member: String,
        scope: Scope,
        binding: BindingEntry,
        env: Map<String, Any?>,
    ): Map<String, Any?>? {
        val callerHash = env["contractHash"] as? String ?: return null
        val receiverHash = binding.definition.contractHash
        if (callerHash == receiverHash) return null

        // Skew detected. Always record it for observability.
        diagnostics.trace(
            "hashSkew", contractId, member, scope.serialize(),
            code = "INCOMPATIBLE_CONTRACT", epoch = epoch,
        )
        if (!strictHashCheck) return null

        return buildMap {
            put("ok", false)
            put("code", "INCOMPATIBLE_CONTRACT")
            put(
                "message",
                "Contract '$contractId' hash mismatch: caller=$callerHash receiver=$receiverHash",
            )
            put("contractId", contractId)
            put("member", member)
            put("scope", scopeToEnvMap(scope))
            put("details", mapOf("callerHash" to callerHash, "receiverHash" to receiverHash))
        }
    }

    internal companion object {
        const val STREAM_BUFFER_CAPACITY = 64

        fun okEnv(value: Any?): Map<String, Any?> = mapOf("ok" to true, "value" to value)

        fun errEnv(
            code: String,
            message: String,
            contractId: String? = null,
            member: String? = null,
            scope: Scope? = null,
        ): Map<String, Any?> = buildMap {
            put("ok", false)
            put("code", code)
            put("message", message)
            if (contractId != null) put("contractId", contractId)
            if (member != null) put("member", member)
            if (scope != null) put("scope", scopeToEnvMap(scope))
        }

        fun scopeToEnvMap(scope: Scope): Map<String, Any?> = when (scope) {
            is Scope.Global -> mapOf("kind" to "global")
            is Scope.Feature -> mapOf("kind" to "feature", "feature" to scope.name)
            is Scope.Instance -> mapOf("kind" to "instance", "feature" to scope.feature, "instance" to scope.tag)
        }
    }
}
