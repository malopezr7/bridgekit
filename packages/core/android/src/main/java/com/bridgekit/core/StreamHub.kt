package com.bridgekit.core

import com.bridgekit.runtime.InboundContractAdapter
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

// StreamHub — multiplexes one provider Flow across N consumers keyed by
// (contractId, member, scope, paramsHash).
//
// Shares ONE provider invocation across all consumers with identical params.
// A second consumer subscribing while one is already running attaches to the
// existing SharedFlow fan-out; the upstream Flow is cancelled only when the
// last consumer detaches (refcount).
//
// `latestOnly` or `sticky` descriptors use replay = 1 on the SharedFlow
// so a late subscriber immediately receives the last emitted item.

internal class StreamHub(
    private val engineScope: CoroutineScope,
) {
    /** Capacity of the upstream buffer before DROP_OLDEST. Mirrors Router STREAM_BUFFER_CAPACITY. */
    private val UPSTREAM_BUFFER = 64

    private data class HubKey(
        val contractId: String,
        val member: String,
        val scopeKey: String,
        val paramsHash: Long,
    )

    private inner class HubEntry(
        val sharedFlow: MutableSharedFlow<Any?>,
        val refCount: AtomicInteger = AtomicInteger(0),
        var upstreamJob: Job? = null,
        // terminalDeferred completes exactly once when upstream terminates (ok or error).
        // Used to detect "already completed" state and deliver terminal to late consumers.
        // CompletableDeferred.await() resolves the same value to all awaiting callers
        // regardless of when they call await() relative to complete().
        val terminalDeferred: CompletableDeferred<Any?> = CompletableDeferred(),
    )

    private val hubs = ConcurrentHashMap<HubKey, HubEntry>()

    /**
     * Attach a consumer to the shared stream for (contractId, member, scope, paramsHash).
     *
     * If no hub entry exists for this key, starts the upstream provider Flow and fans it
     * out via a MutableSharedFlow. On detach (returned lambda), the refcount is decremented;
     * when it reaches 0, the upstream Job is cancelled and the entry is removed.
     *
     * @param contractId  The contract identifier.
     * @param member      The stream member name.
     * @param scope       The binding scope.
     * @param paramsHash  Deterministic hash of encoded params (use stableHash key-sorting).
     * @param adapter     The inbound adapter for this binding (provides the upstream Flow).
     * @param payload     The raw params map forwarded to the adapter's openStream.
     * @param streamEpoch The epoch at which this stream was opened.
     * @param streamId    Unique stream ID for epoch tracking in streamPumpJobs.
     * @param latestOnly  If true, replay = 1 (late subscriber gets last value).
     * @param sticky      Alias for latestOnly.
     * @param onNext      JS consumer callback for each item.
     * @param onEnd       JS consumer callback on stream termination.
     * @return the consumer collection Job. Cancelling it (e.g. Router.closeStream,
     *         epoch swap, or scope cancellation) automatically detaches this consumer
     *         from the hub, releasing the upstream when the last consumer leaves.
     */
    fun attach(
        contractId: String,
        member: String,
        scope: Scope,
        paramsHash: Long,
        adapter: InboundContractAdapter,
        payload: Map<String, Any?>?,
        streamEpoch: Long,
        streamId: String,
        latestOnly: Boolean = false,
        sticky: Boolean = false,
        onNext: (Map<String, Any?>) -> Unit,
        onEnd: (Map<String, Any?>) -> Unit,
    ): Job {
        val key = HubKey(contractId, member, scope.serialize(), paramsHash)
        val replay = if (latestOnly || sticky) 1 else 0

        // getOrCreate hub entry — first caller starts the upstream, rest join.
        // hubs.remove uses value-aware remove(key, entry) so a new entry for the same
        // key (registered after this entry completes) is never accidentally evicted.
        val entry = hubs.getOrPut(key) {
            val shared = MutableSharedFlow<Any?>(
                replay = replay,
                extraBufferCapacity = UPSTREAM_BUFFER,
                onBufferOverflow = BufferOverflow.DROP_OLDEST,
            )
            HubEntry(sharedFlow = shared)
        }

        entry.refCount.incrementAndGet()

        // Start the upstream Flow exactly once (for the first attaching consumer).
        // The try/catch classifies completion as exactly one terminal — HubTerminalError
        // on failure, HUB_TERMINAL_OK on normal completion — and rethrows
        // CancellationException for cooperative cancel.
        synchronized(entry) {
            if (entry.upstreamJob == null || entry.upstreamJob?.isActive == false) {
                entry.upstreamJob = engineScope.launch {
                    try {
                        val flow = adapter.openStream(member, payload)
                        flow
                            .buffer(UPSTREAM_BUFFER, BufferOverflow.DROP_OLDEST)
                            // No .catch here — errors must reach the outer catch so we can
                            // emit HubTerminalError instead of silently emitting HUB_TERMINAL_OK.
                            .collect { value -> entry.sharedFlow.emit(value) }
                        // Upstream completed normally.
                        // Complete terminalDeferred before SharedFlow emit so any consumer
                        // awaiting the deferred sees it atomically with the SharedFlow emission.
                        entry.terminalDeferred.complete(HUB_TERMINAL_OK)
                        entry.sharedFlow.emit(HUB_TERMINAL_OK)
                    } catch (ce: CancellationException) {
                        // Cooperative cancel (epoch-swap, last-consumer-detach). Do NOT emit
                        // any terminal sentinel — the consumer job is already being cancelled.
                        throw ce
                    } catch (e: Throwable) {
                        // Upstream error — complete terminalDeferred with error terminal.
                        val errorTerminal = HubTerminalError(e.message ?: "Stream error")
                        entry.terminalDeferred.complete(errorTerminal)
                        entry.sharedFlow.emit(errorTerminal)
                    } finally {
                        // Value-aware remove — only remove THIS entry, not a live replacement
                        // registered under the same key by a new provider after this one completed.
                        hubs.remove(key, entry)
                    }
                }
            }
        }

        // Early-exit for late consumers: if the upstream already terminated
        // (terminalDeferred is complete), the terminal emission was already dropped by
        // SharedFlow (replay=0). We must deliver it directly via a watcher, not SharedFlow.
        // For ongoing streams (deferred NOT complete) we skip the watcher — sharedFlow.collect
        // handles terminal delivery with no extra overhead.

        val terminalFired = AtomicBoolean(false)

        lateinit var consumerJob: Job
        consumerJob = engineScope.launch {
            // Subscribe to sharedFlow immediately — no child launches before collect.
            // With replay=0 any emission before subscription is registered will be dropped;
            // starting collect first minimises that window.
            try {
                entry.sharedFlow.collect { value ->
                    when {
                        value === HUB_TERMINAL_OK -> {
                            if (terminalFired.compareAndSet(false, true)) {
                                onEnd(mapOf("ok" to true, "value" to null))
                            }
                            // Cancel this consumer's coroutine so the SharedFlow collection
                            // actually stops. invokeOnCompletion below will then call detach().
                            consumerJob.cancel(CancellationException("terminal-ok"))
                        }
                        value is HubTerminalError -> {
                            if (terminalFired.compareAndSet(false, true)) {
                                onEnd(mapOf(
                                    "ok" to false,
                                    "code" to "PROVIDER_ERROR",
                                    "message" to value.message,
                                    "contractId" to contractId,
                                    "member" to member,
                                    "scope" to mapOf("kind" to scope.serialize()),
                                ))
                            }
                            // Cancel so the collector stops — guarantees exactly one terminal.
                            consumerJob.cancel(CancellationException("terminal-error"))
                        }
                        else -> {
                            onNext(mapOf("v" to value))
                        }
                    }
                }
            } finally {
                // Watcher cleanup (if any) handled via invokeOnCompletion below.
            }
        }

        // Launch a watcher ONLY if the upstream has already completed.
        // UNDISPATCHED: starts on the current thread, suspends immediately at await()
        // (which returns instantly since isCompleted is true), then resumes on Default.
        var watcherJob: Job? = null
        if (entry.terminalDeferred.isCompleted) {
            watcherJob = engineScope.launch(start = CoroutineStart.UNDISPATCHED) {
                val storedTerminal = entry.terminalDeferred.await() // returns immediately
                if (terminalFired.compareAndSet(false, true)) {
                    val terminalEnv: Map<String, Any?> = when {
                        storedTerminal === HUB_TERMINAL_OK ->
                            mapOf("ok" to true, "value" to null)
                        storedTerminal is HubTerminalError ->
                            mapOf(
                                "ok" to false,
                                "code" to "PROVIDER_ERROR",
                                "message" to storedTerminal.message,
                                "contractId" to contractId,
                                "member" to member,
                                "scope" to mapOf("kind" to scope.serialize()),
                            )
                        else -> mapOf("ok" to true, "value" to null)
                    }
                    onEnd(terminalEnv)
                    // Cancel the consumer coroutine so sharedFlow.collect stops.
                    consumerJob.cancel(CancellationException("h5-watcher"))
                }
            }
        }

        // Tie the hub refcount to the consumer job lifecycle. On completion or cancellation,
        // detach decrements the refcount and releases the upstream when the last consumer
        // leaves. Also cancels watcherJob to prevent leaks on consumer-cancel paths.
        consumerJob.invokeOnCompletion {
            watcherJob?.cancel()
            detach(contractId, member, scope, paramsHash)
        }

        // Return the consumer job so Router can track it in streamPumpJobs
        return consumerJob
    }

    /**
     * Detach a consumer. Decrements the refcount; cancels upstream + removes hub entry
     * when the last consumer leaves.
     */
    fun detach(contractId: String, member: String, scope: Scope, paramsHash: Long) {
        val key = HubKey(contractId, member, scope.serialize(), paramsHash)
        val entry = hubs[key] ?: return
        if (entry.refCount.decrementAndGet() <= 0) {
            entry.upstreamJob?.cancel()
            // Value-aware remove — only remove THIS entry so a live replacement
            // registered under the same key (new provider after cancel) is not evicted.
            hubs.remove(key, entry)
        }
    }

    /** Cancel all active hub entries (called on epoch swap). */
    fun cancelAll() {
        for (entry in hubs.values) {
            entry.upstreamJob?.cancel()
        }
        hubs.clear()
    }

    companion object {
        /** Sentinel object indicating normal stream completion from upstream. */
        internal val HUB_TERMINAL_OK: Any = object : Any() {}
    }

    internal data class HubTerminalError(val message: String)
}
