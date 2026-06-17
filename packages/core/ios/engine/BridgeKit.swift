// BridgeKit.swift
// BridgeKit iOS engine — public entry point.
//
// Usage:
//   let binding = BridgeKit.default.provide(ConnectHostContract) { ConnectHostImpl() }
//   binding.close()
//
//   // consume() returns the proxy immediately; readiness is deferred to per-call awaitDispatcher().
//   let lia = BridgeKit.default.consume(LiaFeatureContract)
//   let count = try await lia.getUnreadCount()

import Foundation

// MARK: - BridgeKitApi protocol

/// Minimal public API surface of BridgeKit.
public protocol BridgeKitApi: AnyObject {
    // P/C are unconstrained — generated contracts pass protocol existentials
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

// MARK: - BridgeKitRuntime
//
// Named BridgeKitRuntime (not BridgeKit) to avoid a C++ namespace collision in
// the generated Swift/C++ bridge header: a Swift class named "BridgeKit" inside
// a module named "BridgeKit" produces `namespace BridgeKit { class BridgeKit }`,
// causing ambiguous `_impl` lookups in the Nitro C++ bridge.

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

    // MARK: - provide

    /// Register a native provider for [definition] in [scope].
    ///
    /// Returns a Binding handle; call binding.close() to de-register.
    /// If a binding already exists for (contract, scope), it is closed with
    /// .replacing and replaced.
    public func provide<P, C>(
        _ definition: BridgeContractDefinition<P, C>,
        scope: Scope = .global,
        factory: () -> P
    ) -> Binding {
        let impl = factory()
        let adapter = definition.inbound(impl)

        let anyDef = definition as AnyBridgeContractDefinition
        let entry = BindingEntry(definition: anyDef, scope: scope, adapter: adapter)
        router.registerBinding(entry)

        let handle = BindingHandle(entry: entry, router: router)
        return handle
    }

    // MARK: - consume

    /// Obtain a typed consumer proxy for [definition].
    ///
    /// Returns the proxy immediately — readiness deferred to per-call awaitDispatcher.
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

    // MARK: - isProvided

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

    // MARK: - dump

    public func dump() -> String { router.dump() }
}

// MARK: - BindingHandle

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

// MARK: - Router: BridgeKitNativeDelegate conformance

extension Router: BridgeKitNativeDelegate {}
