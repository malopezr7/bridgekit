// BridgeKitDecodeError.swift
// Thrown by generated contract decoders when a required field is absent or
// has the wrong type on the wire. The Router catches it and maps it to a
// VALIDATION_FAILED wire error.
//
// Lives in the runtime ring so generated code — which only imports BridgeKit —
// can throw it without depending on engine internals.

/// Decode failure thrown by generated codecs when a required field is absent
/// or has an incompatible type on the wire.
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
/// Generated codecs use `?? (try bridgeKitThrow(...))` so the `try` keyword sits on
/// a genuine throwing call rather than on a non-throwing closure literal.
///
/// - Parameters:
///   - field: The field name that failed decoding.
///   - expectedType: Human-readable description of the expected type.
/// - Returns: Never returns — always throws.
@inline(__always)
public func bridgeKitThrow<T>(field: String, expectedType: String) throws -> T {
    throw BridgeKitDecodeError(field: field, expectedType: expectedType)
}
