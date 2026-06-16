// BridgeKitDecodeError.swift
// Swift port of io/github/malopezr7/bridgekit/runtime/BridgeKitDecodeException.kt
//
// Thrown by GENERATED contract decoders when a required field is absent or
// has the wrong type on the wire (Design Decision 3 — fail-fast decode).
//
// Generated codecs throw this instead of fabricating defaults. The Router
// catches it and maps it to a VALIDATION_FAILED wire error, mirroring the
// JS-side inbound validation so the codec is symmetric.
//
// Lives in the runtime ring so generated code — which only imports BridgeKit —
// can throw it without depending on engine internals.

/// Decode failure thrown by generated codecs when a required field is absent
/// or has an incompatible type on the wire.
///
/// Port: ``BridgeKitDecodeException`` (JVM) → ``BridgeKitDecodeError`` (Swift Error).
/// Kotlin used a RuntimeException subclass; Swift uses a struct conforming to Error
/// because Swift errors are value types and do not require inheritance.
public struct BridgeKitDecodeError: Error, CustomStringConvertible {
    /// The field name that failed decoding.
    public let field: String
    /// Human-readable description of the type that was expected.
    public let expectedType: String

    public init(field: String, expectedType: String) {
        self.field = field
        self.expectedType = expectedType
    }

    public var description: String {
        "Missing or wrong-typed required field '\(field)' (expected \(expectedType))"
    }
}

/// Throws a ``BridgeKitDecodeError`` from an expression position.
///
/// Swift requires every throwing call to be marked `try`. The generated codecs use
/// the `?? (try bridgeKitThrow(...))` pattern so the `try` keyword sits on a
/// genuine call to a `throws` function rather than on a non-throwing closure literal.
///
/// - Parameters:
///   - field: The field name that failed decoding.
///   - expectedType: Human-readable description of the expected type.
/// - Returns: Never returns — always throws.
@inline(__always)
public func bridgeKitThrow<T>(field: String, expectedType: String) throws -> T {
    throw BridgeKitDecodeError(field: field, expectedType: expectedType)
}
