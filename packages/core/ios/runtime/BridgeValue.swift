// BridgeValue.swift
// Availability wrapper for BridgeKit state values and consume proxies.

/// Availability wrapper for BridgeKit state values and consume proxies.
///
/// - ``available(_:)``: A live provider is present; value comes from the provider.
/// - ``initial(_:)``: No provider yet (or not yet connected); value is the
///   DSL-declared initial. Used before the first provider connects.
/// - ``replacing(_:)``: Provider is reconnecting; last known value is still
///   accessible but marked stale. Transitions to ``available`` if re-provision
///   arrives, or to ``unprovided`` after the grace window expires.
/// - ``unprovided(_:)``: Provider existed but was closed/disconnected; `lastKnown`
///   carries the last observed value for graceful degradation.
public enum BridgeValue<T> {
    /// A live provider is present.
    case available(T)
    /// No provider yet; value is the DSL-declared initial.
    case initial(T)
    /// Provider is reconnecting; `lastKnown` is the last value from the closing provider.
    case replacing(T?)
    /// Provider was closed/disconnected; `lastKnown` is the last observed value.
    case unprovided(T?)

    /// Unwrap the value regardless of availability status.
    /// Returns `nil` for ``replacing(_:)`` / ``unprovided(_:)`` when no prior value exists.
    public func valueOrNil() -> T? {
        switch self {
        case .available(let value):   return value
        case .initial(let value):     return value
        case .replacing(let last):    return last
        case .unprovided(let last):   return last
        }
    }

    /// Re-type the carried value via `transform`, preserving availability state.
    ///
    /// Used by generated outbound State getters to convert the runtime's
    /// `BridgeValue<Any?>` stream into the contract's concrete `BridgeValue<U>`
    /// without an invariant `as!` cast on the whole `AsyncStream`.
    ///
    /// `.available`/`.initial` degrade to `.unprovided(nil)` when `transform`
    /// returns `nil` (decode failure), so a malformed value never traps.
    public func remap<U>(_ transform: (T) -> U?) -> BridgeValue<U> {
        switch self {
        case .available(let value):   return transform(value).map(BridgeValue<U>.available) ?? .unprovided(nil)
        case .initial(let value):     return transform(value).map(BridgeValue<U>.initial) ?? .unprovided(nil)
        case .replacing(let last):    return .replacing(last.flatMap(transform))
        case .unprovided(let last):   return .unprovided(last.flatMap(transform))
        }
    }
}
