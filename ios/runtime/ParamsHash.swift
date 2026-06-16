// ParamsHash.swift
// FNV-1a 32-bit hash over sorted key=value payload entries, matching Kotlin's
// paramsHash byte-for-byte. StreamHub uses this hash for cross-platform stream
// multiplexing — any deviation causes JS and native to derive different keys.
//
// Algorithm:
//   init = 0x811c9dc5, prime = 0x01000193, mask = 0xFFFFFFFF
//   for key in sorted(keys): entry = "$key=${payload[key]}"
//     for char in entry: h ^= char.code; h = (h * prime) & mask
//
// IMPORTANT: Kotlin interpolates null as "null"; Swift String(describing: nil)
// gives "nil". kotlinStringOf(_:) fixes this divergence — do not bypass it.
//
// NOTE: Kotlin iterates UTF-16 Char code units. For ASCII payloads these equal
// Swift Unicode scalar values. Non-ASCII keys or values are a pre-existing
// cross-platform ambiguity in the Kotlin source.

/// FNV-1a 32-bit hash over sorted key=value payload entries.
///
/// Returns `0` for a `nil` or empty payload.
public func paramsHash(_ payload: [String: Any?]?) -> Int64 {
    guard let payload = payload, !payload.isEmpty else { return 0 }

    let fnvInit:  UInt64 = 0x811c9dc5
    let fnvPrime: UInt64 = 0x01000193
    let fnvMask:  UInt64 = 0xFFFFFFFF

    var h: UInt64 = fnvInit

    for key in payload.keys.sorted() {
        let v = payload[key]
        let entry = "\(key)=\(kotlinStringOf(v))"
        for scalar in entry.unicodeScalars {
            h = (h ^ UInt64(scalar.value)) &* fnvPrime & fnvMask
        }
    }

    // Value fits in UInt32 but Kotlin returns Long (Int64) — cast preserving bit pattern.
    return Int64(bitPattern: h)
}

/// Render an `Any?` value the same way Kotlin string interpolation does: null → "null".
///
/// Swift `String(describing: Optional<Any>.none)` yields "nil", not "null".
/// This helper fixes that divergence so hashes match Kotlin byte-for-byte.
private func kotlinStringOf(_ value: Any??) -> String {
    // We receive Any?? because payload values are `Any?` (optional), and Swift wraps
    // them in another optional when passed to a function taking `Any?`.
    guard let outer = value else {
        return "null"
    }
    // Detect Optional.none boxed inside Any — Mirror is the only reliable way.
    let mirror = Mirror(reflecting: outer)
    if mirror.displayStyle == .optional && mirror.children.isEmpty {
        return "null"
    }
    return "\(outer)"
}
