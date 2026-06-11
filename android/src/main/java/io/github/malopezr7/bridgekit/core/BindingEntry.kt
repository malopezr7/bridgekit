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

    private val streamJobs = mutableMapOf<String, Job>()

    override fun close(reason: CloseReason) {
        if (!_isLive) return
        _isLive = false
        bindingScope.cancel("Binding closed: $reason")
    }

    fun registerStreamJob(streamId: String, job: Job) {
        streamJobs[streamId] = job
    }

    fun cancelStreamJob(streamId: String) {
        streamJobs.remove(streamId)?.cancel("Stream closed by engine")
    }

    fun cancelAllStreamJobs() {
        streamJobs.values.forEach { it.cancel("Binding closed") }
        streamJobs.clear()
    }
}
