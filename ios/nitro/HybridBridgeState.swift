// HybridBridgeState.swift
// BridgeKit iOS — Nitro Hybrid implementation for BridgeState.
//
// Port of packages/bridgekit/android/src/main/java/com/margelo/nitro/bridgekit/HybridBridgeState.kt
//
// CLASS NAME: MUST be HybridBridgeState — BridgeKitAutolinking.swift instantiates by exact name.
//
// Requires import NitroModules (only available inside the pod build at L4/L7).

import NitroModules

/// Nitro Hybrid implementation for BridgeState.
/// Delegates all operations to `BridgeKitNative.shared.delegate`.
///
/// Port: `class HybridBridgeState : HybridBridgeStateSpec()` (Kotlin).
public class HybridBridgeState: HybridBridgeStateSpec {

    // `override` (not `required`) — HybridBridgeStateSpec_base.init() is not required.
    public override init() {
        super.init()
    }

    // ---- read ------------------------------------------------------------------

    /// Synchronous state read.
    /// Returns a ResultEnvelope map — { ok: true, v: <encoded-value> } or error envelope.
    ///
    /// Port: `override fun read(env: AnyMap): AnyMap` (Kotlin).
    ///
    /// AnyMap conversions:
    ///   env (AnyMap) → AnyMapCodec.fromAnyMap(env) → [String:Any?] for delegate
    ///   result ([String:Any?]) → AnyMapCodec.toAnyMap(result) → AnyMap for Nitro
    public func read(env: AnyMap) throws -> AnyMap {
        let result = BridgeKitNative.shared.delegate.stateRead(env: AnyMapCodec.fromAnyMap(env))
        return try AnyMapCodec.toAnyMap(result)
    }

    // ---- observe ---------------------------------------------------------------

    /// Subscribe to state changes. Returns an epoch-scoped obsId.
    /// The onChange closure receives { v: <encoded-value> } envelopes.
    ///
    /// Port: `override fun observe(env: AnyMap, onChange: (value: AnyMap) -> Unit): String` (Kotlin).
    ///
    /// AnyMap conversions:
    ///   env (AnyMap) → AnyMapCodec.fromAnyMap(env) → [String:Any?] for delegate
    ///   onChange valueMap ([String:Any?]) → AnyMapCodec.toAnyMap(valueMap) → AnyMap (for Nitro callback)
    ///
    /// PORT NOTE: toAnyMap(_:) in onChange can throw (INV-11). The Kotlin side has no
    /// error path in the onChange lambda — a conversion failure there is a codec/schema bug.
    /// We mirror Kotlin: swallow the throw in onChange and drop the malformed notification.
    /// A // PORT NOTE is placed inline for L4 auditability.
    public func observe(env: AnyMap, onChange: @escaping (_ value: AnyMap) -> Void) throws -> String {
        return BridgeKitNative.shared.delegate.stateObserve(
            env: AnyMapCodec.fromAnyMap(env),
            onChange: { valueMap in
                // PORT NOTE: Kotlin onChange lambda does `onChange(AnyMapCodec.toAnyMap(valueMap))`
                // with no error handling — schema mismatch would throw and crash the coroutine.
                // Swift: try? drops the notification on decode failure rather than propagating
                // a throw through the closure (Nitro callback closures are non-throwing).
                if let nitroValue = try? AnyMapCodec.toAnyMap(valueMap) {
                    onChange(nitroValue)
                }
            }
        )
    }

    // ---- unobserve -------------------------------------------------------------

    /// Cancel a state observation. No-op if obsId is unknown or stale.
    ///
    /// Port: `override fun unobserve(obsId: String)` (Kotlin).
    public func unobserve(obsId: String) throws -> Void {
        BridgeKitNative.shared.delegate.stateUnobserve(obsId: obsId)
    }

    // ---- write -----------------------------------------------------------------

    /// Provider-side state write from JS.
    /// Returns a ResultEnvelope map.
    ///
    /// Port: `override fun write(env: AnyMap): AnyMap` (Kotlin).
    ///
    /// AnyMap conversions:
    ///   env (AnyMap) → AnyMapCodec.fromAnyMap(env) → [String:Any?] for delegate
    ///   result ([String:Any?]) → AnyMapCodec.toAnyMap(result) → AnyMap for Nitro
    public func write(env: AnyMap) throws -> AnyMap {
        let result = BridgeKitNative.shared.delegate.stateWrite(env: AnyMapCodec.fromAnyMap(env))
        return try AnyMapCodec.toAnyMap(result)
    }
}
