// Scope.swift
// Swift port of io/github/malopezr7/bridgekit/core/Scope.kt
//
// Scope for a contract binding. Resolution walks: Instance → Feature → Global.
// Wire serialization MUST be byte-identical to the Kotlin side and the TS side.
// Invariant INV-12: wire strings are the contract — any deviation breaks cross-
// platform routing.
//
// PORT NOTE: Kotlin uses `sealed class` with `object` (Global) and `data class`
// sub-types. Swift enums with associated values are the idiomatic equivalent.
// Kotlin `object Global` is a singleton; Swift `.global` is a case with no
// payload — equivalent for all usage patterns in L1 scope.
//
// PORT NOTE: `Hashable` conformance is manual below because `T` in associated
// values for .feature and .instance are `String`, which is already Hashable.
// Swift synthesizes Equatable/Hashable for enums with Hashable associated values
// when all cases carry Hashable payloads — `.global` has none, which is fine.

/// Scope for a BridgeKit contract binding.
///
/// Resolution order: ``instance(feature:tag:)`` → ``feature(_:)`` → ``global``.
///
/// Port: ``Scope`` (Kotlin sealed class) → ``Scope`` (Swift enum).
public enum Scope: Hashable {
    /// Applies to the entire JS application. Wire string: `"global"`.
    case global
    /// Applies to all instances of a named feature. Wire string: `"feature:<name>"`.
    case feature(String)
    /// Applies to one specific instance of a feature. Wire string: `"instance:<feature>:<tag>"`.
    case instance(feature: String, tag: String)

    // -------------------------------------------------------------------------
    // Wire serialization — INV-12: MUST match Kotlin Scope.serialize() byte-for-byte.
    // -------------------------------------------------------------------------

    /// Serialize this scope to its wire string.
    ///
    /// Port: ``serialize()`` (Kotlin) — renamed from ``serialize()`` to avoid
    /// collision with Swift's `CustomStringConvertible`. Semantics identical.
    public func serialized() -> String {
        switch self {
        case .global:
            return "global"
        case .feature(let name):
            return "feature:\(name)"
        case .instance(let feature, let tag):
            return "instance:\(feature):\(tag)"
        }
    }

    // -------------------------------------------------------------------------
    // Deserialization
    // -------------------------------------------------------------------------

    /// Parse a serialized scope string back into a ``Scope``.
    ///
    /// Falls back to ``global`` for unknown formats, matching Kotlin behaviour.
    ///
    /// Port: ``deserialize(s: String)`` companion function (Kotlin).
    public static func deserialize(_ s: String) -> Scope {
        if s == "global" {
            return .global
        } else if s.hasPrefix("feature:") {
            let name = String(s.dropFirst("feature:".count))
            return .feature(name)
        } else if s.hasPrefix("instance:") {
            let remainder = String(s.dropFirst("instance:".count))
            // Split on first ":" only, keeping the tail intact (tag may contain ":").
            // PORT NOTE: Kotlin uses `split(":", limit = 2)` on the remainder after
            // removePrefix("instance:"), which splits at the FIRST colon and puts the
            // rest (including any subsequent colons) into parts[1]. We replicate that.
            if let colonIndex = remainder.firstIndex(of: ":") {
                let feature = String(remainder[remainder.startIndex..<colonIndex])
                let tag = String(remainder[remainder.index(after: colonIndex)...])
                return .instance(feature: feature, tag: tag)
            } else {
                // Malformed — feature without tag. Fallback matches Kotlin getOrElse("").
                return .instance(feature: remainder, tag: "")
            }
        } else {
            return .global
        }
    }

    /// Parse a scope from a wire envelope map.
    ///
    /// Envelope shape: `{ "kind": "global"|"feature"|"instance", "feature"?: String, "instance"?: String }`
    ///
    /// PORT NOTE: The Kotlin envelope uses key `"instance"` for the `tag` value
    /// (see Router.scopeToEnvMap: `"instance" to scope.tag`). The Swift port
    /// mirrors this key exactly — do NOT rename to "tag" here.
    ///
    /// Port: ``fromEnvelopeMap(map: Map<String, Any?>)`` companion function (Kotlin).
    public static func from(envelopeMap map: [String: Any?]) -> Scope {
        switch map["kind"] as? String {
        case "feature":
            let name = map["feature"] as? String ?? ""
            return .feature(name)
        case "instance":
            let feature = map["feature"] as? String ?? ""
            let tag = map["instance"] as? String ?? ""
            return .instance(feature: feature, tag: tag)
        default:
            return .global
        }
    }
}
