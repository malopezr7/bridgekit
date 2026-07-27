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
    /// Full wire path that failed decoding.
    public let path: String
    /// Leaf field name retained for source compatibility.
    public let field: String
    /// Human-readable description of the type that was expected.
    public let expectedType: String
    /// Runtime type observed on the wire.
    public let actualType: String

    public init(field: String, expectedType: String) {
        self.path = field
        self.field = field
        self.expectedType = expectedType
        self.actualType = "unknown"
    }

    public init(path: String, expectedType: String, actualValue: Any?) {
        self.path = path
        self.field = path.split(separator: ".").last.map(String.init) ?? path
        self.expectedType = expectedType
        self.actualType = actualValue.map { String(describing: type(of: $0)) } ?? "nil"
    }

    public var description: String {
        "Missing or wrong-typed value at '\(path)' (expected \(expectedType), got \(actualType))"
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

/// Throws a path-aware decode error while preserving the runtime wire type.
@inline(__always)
public func bridgeKitThrow<T>(path: String, expectedType: String, actualValue: Any?) throws -> T {
    throw BridgeKitDecodeError(path: path, expectedType: expectedType, actualValue: actualValue)
}

/// Makes decode failures observable when a non-throwing generated surface cannot propagate them.
public func bridgeKitReportDecodeError(_ error: Error, context: String) {
    print("[bridgekit] decode failure in \(context): \(error)")
}
