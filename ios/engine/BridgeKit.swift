// BridgeKit.swift
// BridgeKit iOS engine — public entry point for the BridgeKit Swift core.
//
// Port of io/github/malopezr7/bridgekit/core/BridgeKit.kt
//
// Usage:
//   // Provide a native contract:
//   let binding = BridgeKit.default.provide(ConnectHostContract) { ConnectHostImpl() }
//   binding.close()
//
//   // Consume a JS-provided contract (proxy returned IMMEDIATELY):
//   let lia = BridgeKit.default.consume(LiaFeatureContract)
//   let count = try await lia.getUnreadCount()
//
// PORT NOTE: `consume()` returns the proxy IMMEDIATELY (no awaitProvided at call site).
// Readiness is deferred to per-call awaitDispatcher() in OutboundCallerImpl.
// This matches the Kotlin behaviour after the "multi-second loader fix" in BridgeKit.kt.

import Foundation

// ---- BridgeKitApi protocol -------------------------------------------------

/// Minimal public API surface of BridgeKit.
///
/// Port: `interface BridgeKitApi` (Kotlin).
public protocol BridgeKitApi: AnyObject {
    // L7fix2: P/C unconstrained — generated contracts pass protocol existentials
    // (`any FooContract`) which do not satisfy an `AnyObject` generic constraint.
    func provide<P, C>(
        _ definition: BridgeContractDefinition<P, C>,
        scope: Scope,
        factory: () -> P
    ) -> Binding

    func consume<P, C>(
        _ definition: BridgeContractDefinition<P, C>,
        scope: Scope
    ) -> C

    func isProvided<P, C>(
        _ definition: BridgeContractDefinition<P, C>,
        scope: Scope
    ) -> Bool
}

// ---- BridgeKitRuntime -------------------------------------------------------
//
// NOTE: Named BridgeKitRuntime (not BridgeKit) to avoid a C++ namespace
// collision in the generated Swift/C++ bridge header. When the Swift module is
// named "BridgeKit" and a Swift class is also named "BridgeKit", the generated
// header produces `namespace BridgeKit { class BridgeKit }` which causes
// ambiguous `_impl` lookups in the Nitro C++ bridge. Renaming the class to
// BridgeKitRuntime resolves this with no semantic change.
//
// Port of io/github/malopezr7/bridgekit/core/BridgeKit.kt (Kotlin class BridgeKit).

public final class BridgeKitRuntime: BridgeKitApi {

    /// Shared default instance. Use for production.
    public static let `default`: BridgeKitRuntime = {
        let bk = BridgeKitRuntime()
        bk._installAsDelegate()
        return bk
    }()

    internal let router: Router

    public init(
        readinessTimeoutMs: UInt64 = 5_000,
        callTimeoutMs: UInt64 = 30_000
    ) {
        self.router = Router(
            readinessTimeoutMs: readinessTimeoutMs,
            callTimeoutMs: callTimeoutMs
        )
    }

    private func _installAsDelegate() {
        BridgeKitNative.shared.delegate = router
    }

    // ---- provide -----------------------------------------------------------

    /// Register a native provider for [definition] in [scope].
    ///
    /// Returns a Binding handle; call binding.close() to de-register.
    /// If a binding already exists for (contract, scope), it is closed with
    /// .replacing and replaced.
    ///
    /// PORT NOTE: Kotlin has `eager: Boolean` param. Swift uses a trailing closure;
    /// factory is called immediately (eager=true is the only sane default for Swift
    /// since lazy involves threading concerns managed by the caller).
    public func provide<P, C>(
        _ definition: BridgeContractDefinition<P, C>,
        scope: Scope = .global,
        factory: () -> P
    ) -> Binding {
        let impl = factory()
        let adapter = definition.inbound(impl)

        // Type-erase the definition for BindingEntry storage.
        let anyDef = definition as AnyBridgeContractDefinition
        let entry = BindingEntry(definition: anyDef, scope: scope, adapter: adapter)
        router.registerBinding(entry)

        // Return a Binding handle that proxies close() to the engine.
        let handle = BindingHandle(entry: entry, router: router)
        return handle
    }

    // ---- consume -----------------------------------------------------------

    /// Obtain a typed consumer proxy for [definition].
    ///
    /// Returns the proxy IMMEDIATELY — readiness deferred to per-call awaitDispatcher.
    ///
    /// PORT NOTE: Kotlin consume() is suspend; Swift does NOT suspend here.
    /// The JS readiness wait happens inside each OutboundCallerImpl method.
    public func consume<P, C>(
        _ definition: BridgeContractDefinition<P, C>,
        scope: Scope = .global
    ) -> C {
        let caller = OutboundCallerImpl(
            contractId: definition.id,
            scope: scope,
            router: router,
            readinessTimeoutMs: router.readinessTimeoutMs,
            callTimeoutMs: router.callTimeoutMs
        )
        return definition.outbound(caller)
    }

    // ---- isProvided --------------------------------------------------------

    public func isProvided<P, C>(
        _ definition: BridgeContractDefinition<P, C>,
        scope: Scope = .global
    ) -> Bool {
        router.isProvided(contractId: definition.id, scope: scope)
    }

    /// Await until a contract is provided, with explicit timeout.
    public func awaitProvided<P, C>(
        _ definition: BridgeContractDefinition<P, C>,
        scope: Scope = .global,
        timeoutMs: UInt64 = 30_000
    ) async -> Bool {
        await router.awaitProvided(contractId: definition.id, scope: scope, timeoutMs: timeoutMs)
    }

    // ---- dump --------------------------------------------------------------

    public func dump() -> String { router.dump() }
}

// ---- BindingHandle (concrete Binding impl) ---------------------------------

private final class BindingHandle: Binding {
    private let entry: BindingEntry
    private unowned(unsafe) let router: Router

    init(entry: BindingEntry, router: Router) {
        self.entry = entry
        self.router = router
    }

    var contractId: String { entry.contractId }
    var scope: Scope { entry.scope }
    var isLive: Bool { entry.isLive }

    func close(reason: CloseReason) {
        guard entry.isLive else { return }
        entry.close(reason: reason)
        router.removeBinding(entry)
    }
}

// ---- Router: BridgeKitNativeDelegate conformance ---------------------------

// Wire Router as the delegate implementation so BridgeKitNative.shared.delegate = router.
extension Router: BridgeKitNativeDelegate {}
