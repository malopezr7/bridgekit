// AnyMapCodec.swift
// Swift port of packages/bridgekit/android/src/main/java/com/bridgekit/codec/AnyMapCodec.kt
//
// Bulk AnyMap ↔ [String: Any?] conversion helpers.
// All Hybrid implementations must use ONLY these helpers — never iterate
// fields individually.
//
// Invariant INV-11: toAnyMap THROWS on incompatible values (ignoreIncompatible = false).
// This is a hard requirement. The Kotlin side uses AnyMap.fromMap(map, false);
// the Swift equivalent is AnyMap.fromDictionary(_:) which also throws on incompatible.
// DO NOT substitute fromDictionaryIgnoreIncompatible — that silently drops fields
// and would violate INV-11, turning codec bugs into silent data loss.
//
// PORT NOTE: The Kotlin AnyMapCodec is an `object` (singleton). Swift uses an
// `enum` with no cases as the idiomatic namespace-with-no-instances pattern.
// All functions are `static`; callers use `AnyMapCodec.toAnyMap(...)`.
//
// PORT NOTE: NitroModules Swift AnyMap API verified from generated specs:
//   - `AnyMap.fromDictionary(_ dict: [String: Any?]) throws -> AnyMap`
//     (throws on incompatible value — matches Kotlin `fromMap(map, false)`)
//   - `anyMap.toDictionary() -> [String: Any?]`
//     (matches Kotlin `toHashMap()`)
// Both methods exist in NitroModules; source confirmed from explore artifact.
// This file will NOT compile standalone — it depends on `import NitroModules`
// which is only available inside the pod/Xcode build (resolved at L4/L7).

import NitroModules

/// Bulk ``AnyMap`` ↔ `[String: Any?]` conversion.
///
/// Port: ``AnyMapCodec`` object (Kotlin) → ``AnyMapCodec`` enum namespace (Swift).
public enum AnyMapCodec {
    /// Convert a plain `[String: Any?]` dictionary to an ``AnyMap`` for passing
    /// across the Nitro bridge.
    ///
    /// The map is always framework-constructed (codec output), so every value must
    /// be AnyMap-compatible (primitives, nested maps, arrays). Throwing on incompatible
    /// values surfaces framework/codegen bugs loudly rather than silently corrupting data.
    ///
    /// - Throws: ``BridgeKitDecodeError`` (wrapped) or a NitroModules error if any
    ///   value in `map` is not AnyMap-compatible.
    ///
    /// Port: ``toAnyMap(map: Map<String, Any?>) = AnyMap.fromMap(map, false)`` (Kotlin).
    public static func toAnyMap(_ map: [String: Any?]) throws -> AnyMap {
        // PORT NOTE: Kotlin calls AnyMap.fromMap(map, ignoreIncompatible=false).
        // Swift Nitro equivalent is AnyMap.fromDictionary(_:) which throws on
        // incompatible values — identical semantics, different method name.
        return try AnyMap.fromDictionary(map)
    }

    /// Convert an ``AnyMap`` from the Nitro bridge to a plain `[String: Any?]`.
    /// Returns an empty dictionary if `anyMap` is `nil`.
    ///
    /// Port: ``fromAnyMap(anyMap: AnyMap?) = anyMap?.toHashMap() ?: emptyMap()`` (Kotlin).
    public static func fromAnyMap(_ anyMap: AnyMap?) -> [String: Any?] {
        return anyMap?.toDictionary() ?? [:]
    }
}
