// BridgeContractDefinition.swift
// BridgeKit iOS runtime — generated contract definition base type.
//
// Lives in the runtime ring so generated code can reference it without depending
// on engine internals. Generics are erased to AnyObject at the engine boundary;
// generated subclasses re-specialize.

import Foundation

// MARK: - OutboundCaller protocol

/// Injected by the engine into the generated outbound proxy.
public protocol OutboundCaller: AnyObject {
    /// Async call into a JS-provided contract method.
    func invoke(member: String, payload: [String: Any?]?) async throws -> Any?

    /// Synchronous call (native-provided contracts only).
    func invokeSync(member: String, payload: [String: Any?]?) throws -> Any?

    /// Fire-and-forget. Errors are swallowed.
    func fire(member: String, payload: [String: Any?]?)

    /// Open an AsyncThrowingStream for a JS-provided stream member.
    func stream(member: String, payload: [String: Any?]?) -> AsyncThrowingStream<Any?, Error>

    /// Return an AsyncStream<BridgeValue<Any?>> for a JS-provided state member.
    func state(member: String) -> AsyncStream<BridgeValue<Any?>>
}

// MARK: - BridgeContractDefinition

/// Base class for generated contract definitions.
///
/// [P] — provider type (native-side implementation).
/// [C] — consumer type (typed proxy returned to callers).
///
/// P/C are unconstrained: generated contracts pass protocol existentials (`any BridgekitDemoHost`)
/// which do not satisfy an `AnyObject` constraint even when the protocol is `: AnyObject`.
/// The engine type-erases via AnyBridgeContractDefinition and never needs P/C to be a class.
open class BridgeContractDefinition<P, C> {

    /// Stable reverse-DNS contract identifier.
    public let id: String

    /// FNV-1a hash of the normalized contract descriptor (drift detection).
    public let contractHash: String

    /// Per-member hashes keyed "methods.name", "streams.name", "state.name".
    public let memberHashes: [String: String]

    public init(id: String, contractHash: String, memberHashes: [String: String]) {
        self.id = id
        self.contractHash = contractHash
        self.memberHashes = memberHashes
    }

    /// Wrap a provider in an InboundContractAdapter.
    /// Override in generated code.
    open func inbound(_ impl: P) -> InboundContractAdapter {
        fatalError("BridgeContractDefinition.inbound(_:) must be overridden by generated code for contract '\(id)'")
    }

    /// Build a typed consumer proxy backed by an OutboundCaller.
    /// Override in generated code.
    open func outbound(_ caller: OutboundCaller) -> C {
        fatalError("BridgeContractDefinition.outbound(_:) must be overridden by generated code for contract '\(id)'")
    }
}

// MARK: - AnyBridgeContractDefinition

/// Engine-internal protocol that erases P/C generics for storage.
protocol AnyBridgeContractDefinition: AnyObject {
    var id: String { get }
    var contractHash: String { get }
    var memberHashes: [String: String] { get }
}

extension BridgeContractDefinition: AnyBridgeContractDefinition {}
