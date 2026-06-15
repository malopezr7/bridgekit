package io.github.malopezr7.bridgekit.core

import io.github.malopezr7.bridgekit.runtime.BridgeContractDefinition
import io.github.malopezr7.bridgekit.runtime.InboundContractAdapter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel

/**
 * Internal representation of a live provider binding.
 *
 * Holds the adapter and a coroutine scope tied to its lifetime.
 * Scope is cancelled when the binding is closed, which cancels all:
 *  - open stream pump Jobs tied to this binding
 *  - ongoing state flow collection jobs
 */
internal class BindingEntry(
    val definition: BridgeContractDefinition<*, *>,
    override val scope: Scope,
    val adapter: InboundContractAdapter,
    val bindingScope: CoroutineScope,
) : Binding {

    override val contractId: String get() = definition.id

    @Volatile
    private var _isLive = true
    override val isLive: Boolean get() = _isLive

    // H-7: ConcurrentHashMap — safe for concurrent put (JS/Nitro thread) vs
    // cancelAllStreamJobs (engine thread). Prevents ConcurrentModificationException.
    private val streamJobs = java.util.concurrent.ConcurrentHashMap<String, Job>()

    override fun close(reason: CloseReason) {
        if (!_isLive) return
        _isLive = false
        bindingScope.cancel("Binding closed: $reason")
    }

    fun registerStreamJob(streamId: String, job: Job) {
        // H-7: recheck _isLive after acquiring the slot. If the binding was closed between
        // the caller's check and this put, cancel the job immediately so it doesn't linger.
        streamJobs[streamId] = job
        if (!_isLive) {
            streamJobs.remove(streamId)
            job.cancel("Binding already closed at registerStreamJob time")
        }
    }

    fun cancelStreamJob(streamId: String) {
        streamJobs.remove(streamId)?.cancel("Stream closed by engine")
    }

    fun cancelAllStreamJobs() {
        streamJobs.values.forEach { it.cancel("Binding closed") }
        streamJobs.clear()
    }
}
