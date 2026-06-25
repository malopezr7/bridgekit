// AnyMapCodec.swift
// Bulk AnyMap ↔ [String: Any?] conversion helpers.
// All Hybrid implementations must use ONLY these helpers — never iterate fields individually.
//
// toAnyMap THROWS on incompatible values (AnyMap.fromDictionary, ignoreIncompatible = false).
// DO NOT substitute fromDictionaryIgnoreIncompatible — that silently drops fields.
//
// This file will NOT compile standalone — requires NitroModules (pod/Xcode build only).

@_implementationOnly import NitroModules

/// Bulk ``AnyMap`` ↔ `[String: Any?]` conversion.
enum AnyMapCodec {
    /// Convert a plain `[String: Any?]` dictionary to an ``AnyMap`` for passing
    /// across the Nitro bridge.
    ///
    /// Throws if any value is not AnyMap-compatible — surfaces codegen bugs loudly
    /// rather than silently corrupting data.
    ///
    /// - Throws: ``BridgeKitDecodeError`` (wrapped) or a NitroModules error if any
    ///   value in `map` is not AnyMap-compatible.
    static func toAnyMap(_ map: [String: Any?]) throws -> AnyMap {
        return try AnyMap.fromDictionary(map)
    }

    /// Convert an ``AnyMap`` from the Nitro bridge to a plain `[String: Any?]`.
    /// Returns an empty dictionary if `anyMap` is `nil`.
    static func fromAnyMap(_ anyMap: AnyMap?) -> [String: Any?] {
        return anyMap?.toDictionary() ?? [:]
    }
}
