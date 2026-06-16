// BridgeContractDefinition.swift
// BridgeKit iOS runtime — generated contract definition base type.
//
// Port of io/github/malopezr7/bridgekit/runtime/BridgeContractDefinition.kt
//
// This file lives in the runtime ring so generated code (`import BridgeKit`) can
// reference it without depending on engine internals.
//
// PORT NOTE: Kotlin uses an abstract class with generics and a sealed companion.
// Swift uses an open class. Generics are erased to AnyObject at the engine boundary;
// generated subclasses re-specialize.

import Foundation

// ---- Marker annotation (Swift equivalent) ----------------------------------

// Kotlin: `@BridgeKitGeneratedApiV1` — Swift has no equivalent runtime annotation,
// but we document the freeze contract in comments. Generated code references this
// class by name in the `import BridgeKit` surface.

// ---- OutboundCaller protocol -----------------------------------------------

/// Injected by the engine into the generated outbound proxy.
///
/// Port: `interface OutboundCaller` (Kotlin).
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

// ---- BridgeContractDefinition ----------------------------------------------

/// Base class for generated contract definitions.
///
/// [P] — provider type (native-side implementation).
/// [C] — consumer type (typed proxy returned to callers).
///
/// Port: `abstract class BridgeContractDefinition<P, C>` (Kotlin).
///
/// L7fix2: P/C are UNCONSTRAINED (matching the Kotlin reference `<P, C>`). They
/// were briefly `<P: AnyObject, C: AnyObject>`, but generated contracts use
/// class-bound *protocol existentials* (`any BridgekitDemoHost`) as P/C, and a
/// Swift existential does not satisfy an `AnyObject` generic constraint even when
/// the protocol itself is `: AnyObject`. The engine never relies on P/C being a
/// class (it type-erases via AnyBridgeContractDefinition), so the constraint was
/// purely over-restrictive and blocked the generated contracts from compiling.
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

// ---- Type-erased bridge for engine internals --------------------------------

/// Engine-internal wrapper that erases P/C generics for storage.
///
/// PORT NOTE: Kotlin BindingEntry holds `BridgeContractDefinition<*, *>` (star projection).
/// Swift cannot directly erase open class generics at the variable site; we use a
/// protocol wrapper instead so BindingEntry doesn't need to know P/C.
public protocol AnyBridgeContractDefinition: AnyObject {
    var id: String { get }
    var contractHash: String { get }
    var memberHashes: [String: String] { get }
}

extension BridgeContractDefinition: AnyBridgeContractDefinition {}

// Convenience typealiases used by BindingEntry (engine-internal).
// PORT NOTE: In Kotlin BindingEntry held `BridgeContractDefinition<Any, Any>`.
// Swift requires concrete type args; we wrap via the protocol above.
