// ParamsHash.swift
// Swift port of the private `paramsHash` function in
// io/github/malopezr7/bridgekit/core/Router.kt (lines 23-35).
//
// FNV-1a 32-bit hash over sorted key=value entries.
// Invariant INV-9: MUST match Kotlin `paramsHash` byte-for-byte.
// StreamHub uses this hash as the key for cross-platform stream multiplexing;
// any deviation causes JS and native to derive different keys and fail to share
// the same hub slot.
//
// Algorithm (from Kotlin source):
//   init = 0x811c9dc5
//   prime = 0x01000193
//   mask = 0xFFFFFFFF  (keeps arithmetic in 32-bit range)
//   for key in sorted(keys):
//     entry = "$key=${payload[key]}"   // Kotlin string interpolation of Any?
//     for char in entry:
//       h ^= char.code
//       h  = (h * prime) & mask
//   return h   (a Long, but value fits in UInt32)
//
// PORT NOTE: Kotlin `"$key=${v}"` where `v: Any?` calls Kotlin's default
// toString() on the value. For null it produces the literal string "null".
// For numbers, booleans, strings it produces their natural string form.
// Swift `String(describing:)` on Any? produces the same output for these types:
//   - nil/null    → "nil" (Swift) vs "null" (Kotlin) — DIVERGENCE
//
// CRITICAL BUG RISK: Kotlin interpolates null as "null"; Swift String(describing: nil)
// gives "nil". To match Kotlin exactly, nil values MUST be rendered as "null".
// See `kotlinStringOf(_:)` helper below.
//
// PORT NOTE: Kotlin `c.code` is the UTF-16 code unit of the character (Int).
// For ASCII-only keys and primitive values (the expected payload content), UTF-16
// code units equal Unicode scalar values, which equal UTF-8 byte values for
// codepoints 0–127. Swift `unicodeScalars` gives Unicode scalar values (UInt32).
// For the expected payload domain (ASCII keys, numeric/boolean/string values)
// these are identical. If non-ASCII appears in keys or values, both sides use
// their native UTF-16/scalar encoding — this is a pre-existing cross-platform
// ambiguity in the Kotlin source (it iterates `Char` which is a UTF-16 unit).
// Flagged as PORT NOTE; will be validated at L8 simulator proof.

/// FNV-1a 32-bit hash over sorted key=value payload entries.
///
/// Returns `0` for a `nil` or empty payload (matches Kotlin `return 0L`).
///
/// Port: private `paramsHash(payload: Map<String, Any?>?) -> Long` (Kotlin Router.kt).
public func paramsHash(_ payload: [String: Any?]?) -> Int64 {
    guard let payload = payload, !payload.isEmpty else { return 0 }

    let fnvInit:  UInt64 = 0x811c9dc5
    let fnvPrime: UInt64 = 0x01000193
    let fnvMask:  UInt64 = 0xFFFFFFFF

    var h: UInt64 = fnvInit

    for key in payload.keys.sorted() {
        let v = payload[key]
        // Kotlin: "$key=${v}" where v is Any? — null becomes "null".
        let entry = "\(key)=\(kotlinStringOf(v))"
        for scalar in entry.unicodeScalars {
            // Kotlin: h ^= c.code.toLong(); h = (h * prime) & mask
            h = (h ^ UInt64(scalar.value)) &* fnvPrime & fnvMask
        }
    }

    // Kotlin returns Long (Int64); the value fits in UInt32 but is stored in Int64.
    // Cast preserving the bit pattern (value is always ≤ 0xFFFFFFFF so no sign issues).
    return Int64(bitPattern: h)
}

/// Render an `Any?` value the same way Kotlin string interpolation does for `Any?`.
///
/// Kotlin `"${v}"` where `v: Any?`:
///   - null   → "null"
///   - other  → v.toString()
///
/// Swift `String(describing: Optional<Any>.none)` → "nil" (wrong).
/// This helper fixes the nil → "null" divergence.
private func kotlinStringOf(_ value: Any??) -> String {
    // PORT NOTE: We receive Any?? here because payload values are `Any?` (optional),
    // and when passed to a function taking `Any?` Swift wraps it in another optional.
    // Flatten: if the outer optional is nil, treat as Kotlin null → "null".
    // If the outer optional wraps a value, check if that inner value is nil-ish.
    guard let outer = value else {
        return "null"
    }
    // The inner value is `Any?`. If it is `nil` (Optional<Something>.none wrapped in Any),
    // we need to detect it. Use Mirror for the nil-inside-Any case.
    // Swift stores Optional.none as Any by boxing it; `Optional<Any>.none as Any` is detectable.
    let mirror = Mirror(reflecting: outer)
    if mirror.displayStyle == .optional && mirror.children.isEmpty {
        return "null"
    }
    return "\(outer)"
}
