package io.github.malopezr7.bridgekit.core

import io.github.malopezr7.bridgekit.discovery.BridgeKitHost
import io.github.malopezr7.bridgekit.discovery.BridgeKitModule
import io.github.malopezr7.bridgekit.runtime.BridgeContractDefinition
import io.github.malopezr7.bridgekit.runtime.BridgeKitNative
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.util.ServiceLoader

/**
 * Public entry point for the BridgeKit Kotlin core.
 *
 * Usage:
 *   // DI-friendly:
 *   val bridgeKit = BridgeKit.default
 *
 *   // Provide a native contract:
 *   val binding = bridgeKit.provide(ConnectHostContract) { ConnectHostImpl(deps) }
 *   binding.close()
 *
 *   // Consume a JS-provided contract:
 *   val lia = bridgeKit.consume(LiaFeatureContract)
 *   val count = lia.getUnreadCount()
 */
class BridgeKit internal constructor(
    internal val router: Router = Router(StateStore(), ParkBuffer()),
    private val mainThreadChecker: MainThreadChecker = AndroidMainThreadChecker,
) : BridgeKitApi {

    companion object {
        /** Shared default instance. Use for production; inject custom instances for tests. */
        val default: BridgeKit by lazy {
            BridgeKit().also { it._installAsDelegate() }
        }

        /** Tracing flag — mirrors [io.github.malopezr7.bridgekit.diagnostics.BridgeKitDiagnostics.devTracing]. */
        var devTracing: Boolean
            get() = io.github.malopezr7.bridgekit.diagnostics.BridgeKitDiagnostics.devTracing
            set(value) { io.github.malopezr7.bridgekit.diagnostics.BridgeKitDiagnostics.devTracing = value }
    }

    init {
        // Non-default instances used in tests may also need the delegate installed
    }

    private fun _installAsDelegate() {
        BridgeKitNative.delegate = router
    }

    // ============================================================================
    // provide
    // ============================================================================

    /**
     * Register a native provider for [definition] in [scope].
     *
     * The [factory] is invoked lazily (at first call) unless [eager] is true.
     * Returns a [Binding] handle; call [Binding.close] to de-register.
     *
     * If a binding already exists for (contract, scope), it is closed with
     * [CloseReason.Replacing] and replaced by the new one.
     */
    override fun <P : Any, C : Any> provide(
        definition: BridgeContractDefinition<P, C>,
        scope: Scope,
        eager: Boolean,
        factory: () -> P,
    ): Binding {
        val impl = if (eager) factory() else lazy(factory)
        val bindingScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val adapter = if (eager) {
            @Suppress("UNCHECKED_CAST")
            definition.inbound(impl as P)
        } else {
            // Lazy adapter: impl is resolved on first invocation
            @Suppress("UNCHECKED_CAST")
            LazyInboundAdapter(definition as BridgeContractDefinition<Any, Any>, impl as Lazy<Any>)
        }

        val entry = BindingEntry(definition, scope, adapter, bindingScope)
        router.registerBinding(entry)

        // Wire up close: when the binding entry is closed, remove from router
        val bindingHandle = object : Binding {
            override val contractId: String get() = entry.contractId
            override val scope: Scope get() = entry.scope
            override val isLive: Boolean get() = entry.isLive

            override fun close(reason: CloseReason) {
                if (!entry.isLive) return
                entry.close(reason)
                router.removeBinding(entry)
            }
        }
        return bindingHandle
    }

    // ============================================================================
    // consume
    // ============================================================================

    /**
     * Obtain a typed consumer proxy for [definition].
     * Suspends until the contract is provided (bounded by readiness timeout).
     * Throws [BridgeKitException] if unavailable after timeout.
     */
    override suspend fun <P : Any, C : Any> consume(
        definition: BridgeContractDefinition<P, C>,
        scope: Scope,
    ): C {
        val caller = OutboundCallerImpl(
            contractId = definition.id,
            scope = scope,
            router = router,
            mainThreadChecker = mainThreadChecker,
            readinessTimeoutMs = router.readinessTimeoutMs,
            callTimeoutMs = router.callTimeoutMs,
        )
        // Await readiness before returning proxy (but proxy calls still re-await if needed)
        if (!router.awaitProvided(definition.id, scope, router.readinessTimeoutMs)) {
            // JS-provided: no native binding — that's OK, proxy handles dispatcher readiness
            // For native → JS contracts we don't have native bindings, just dispatcher wait.
        }
        return definition.outbound(caller)
    }

    /**
     * Return a consumer proxy immediately (null if not currently provided).
     */
    fun <P : Any, C : Any> tryConsume(
        definition: BridgeContractDefinition<P, C>,
        scope: Scope = Scope.Global,
    ): C? {
        if (!router.isProvided(definition.id, scope)) return null
        val caller = OutboundCallerImpl(
            contractId = definition.id,
            scope = scope,
            router = router,
            mainThreadChecker = mainThreadChecker,
        )
        return definition.outbound(caller)
    }

    /** Check if a contract is currently provided. */
    override fun <P : Any, C : Any> isProvided(
        definition: BridgeContractDefinition<P, C>,
        scope: Scope,
    ): Boolean = router.isProvided(definition.id, scope)

    /** Await until a contract is provided, with explicit timeout. */
    suspend fun <P : Any, C : Any> awaitProvided(
        definition: BridgeContractDefinition<P, C>,
        scope: Scope = Scope.Global,
        timeoutMs: Long = 30_000,
    ): Boolean = router.awaitProvided(definition.id, scope, timeoutMs)

    // ============================================================================
    // initialize (ServiceLoader discovery)
    // ============================================================================

    /**
     * Run ServiceLoader discovery for global-scope modules.
     * Must be called BEFORE reactHost.start() — modules register synchronously.
     *
     * Hard-errors (throws [IllegalStateException]) on duplicate global provide of the same
     * contract id by two different modules.
     */
    fun initialize(host: BridgeKitHost) {
        val modules = ServiceLoader.load(BridgeKitModule::class.java).toList()
        val registeredIds = mutableMapOf<String, String>() // contractId → module class name

        for (module in modules) {
            val moduleName = module.javaClass.name
            val guardedBridgeKit = GuardedBridgeKit(this, registeredIds, moduleName)
            module.register(guardedBridgeKit, host)
        }
    }

    // ============================================================================
    // dump
    // ============================================================================

    /**
     * Return a structured one-line-per-entry diagnostic dump.
     * Safe to call from any thread.
     */
    fun dump(): String = router.dump()
}

// ============================================================================
// LazyInboundAdapter — wraps a lazy factory with an InboundContractAdapter
// ============================================================================

private class LazyInboundAdapter(
    private val definition: BridgeContractDefinition<Any, Any>,
    private val lazyImpl: Lazy<Any>,
) : io.github.malopezr7.bridgekit.runtime.InboundContractAdapter {

    private val adapter: io.github.malopezr7.bridgekit.runtime.InboundContractAdapter by lazy {
        definition.inbound(lazyImpl.value)
    }

    override val stateInitials: Map<String, Any?> get() = adapter.stateInitials
    override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? = adapter.invoke(member, payload)
    override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = adapter.invokeSync(member, payload)
    override fun openStream(member: String, payload: Map<String, Any?>?): kotlinx.coroutines.flow.Flow<Any?> = adapter.openStream(member, payload)
    override fun stateFlows(): Map<String, kotlinx.coroutines.flow.StateFlow<Any?>> = adapter.stateFlows()
}

// ============================================================================
// GuardedBridgeKit — wraps BridgeKit for duplicate-global-provide detection
// ============================================================================

/**
 * Passed to each [BridgeKitModule] during ServiceLoader discovery.
 * Delegates to the real [BridgeKit] but rejects duplicate global provides.
 */
internal class GuardedBridgeKit(
    private val delegate: BridgeKit,
    private val registeredIds: MutableMap<String, String>,
    private val moduleName: String,
) : BridgeKitApi {

    override fun <P : Any, C : Any> provide(
        definition: BridgeContractDefinition<P, C>,
        scope: Scope,
        eager: Boolean,
        factory: () -> P,
    ): Binding {
        if (scope is Scope.Global) {
            val existing = registeredIds[definition.id]
            if (existing != null) {
                throw IllegalStateException(
                    "BridgeKit ServiceLoader: duplicate global provide for contract '${definition.id}'. " +
                        "Already registered by '$existing', attempted again by '$moduleName'.",
                )
            }
            registeredIds[definition.id] = moduleName
        }
        return delegate.provide(definition, scope, eager, factory)
    }

    override suspend fun <P : Any, C : Any> consume(
        definition: BridgeContractDefinition<P, C>,
        scope: Scope,
    ): C = delegate.consume(definition, scope)

    override fun <P : Any, C : Any> isProvided(
        definition: BridgeContractDefinition<P, C>,
        scope: Scope,
    ): Boolean = delegate.isProvided(definition, scope)
}
