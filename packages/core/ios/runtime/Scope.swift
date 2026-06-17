// Scope.swift
// Scope for a contract binding. Resolution walks: Instance → Feature → Global.
// Wire strings MUST be byte-identical across iOS, Android, and TS — any deviation
// breaks cross-platform routing.

/// Scope for a BridgeKit contract binding.
///
/// Resolution order: ``instance(feature:tag:)`` → ``feature(_:)`` → ``global``.
public enum Scope: Hashable {
    /// Applies to the entire JS application. Wire string: `"global"`.
    case global
    /// Applies to all instances of a named feature. Wire string: `"feature:<name>"`.
    case feature(String)
    /// Applies to one specific instance of a feature. Wire string: `"instance:<feature>:<tag>"`.
    case instance(feature: String, tag: String)

    // MARK: - Wire serialization

    /// Serialize this scope to its wire string.
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

    // MARK: - Deserialization

    /// Parse a serialized scope string back into a ``Scope``.
    /// Falls back to ``global`` for unknown formats.
    public static func deserialize(_ s: String) -> Scope {
        if s == "global" {
            return .global
        } else if s.hasPrefix("feature:") {
            let name = String(s.dropFirst("feature:".count))
            return .feature(name)
        } else if s.hasPrefix("instance:") {
            let remainder = String(s.dropFirst("instance:".count))
            // Split on first ":" only — tag may itself contain ":" (Kotlin limit=2 semantics).
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
    /// The envelope uses key `"instance"` for the tag value — do NOT rename to "tag".
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
