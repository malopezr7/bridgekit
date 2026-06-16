// HybridBridgeState.swift
// BridgeKit iOS — Nitro Hybrid implementation for BridgeState.
//
// CLASS NAME: MUST be HybridBridgeState — BridgeKitAutolinking.swift instantiates by exact name.
//
// Requires import NitroModules (only available inside the pod build).

import NitroModules

/// Nitro Hybrid implementation for BridgeState.
/// Delegates all operations to `BridgeKitNative.shared.delegate`.
public class HybridBridgeState: HybridBridgeStateSpec {

    // `override` (not `required`) — HybridBridgeStateSpec_base.init() is not required.
    public override init() {
        super.init()
    }

    // MARK: - read

    /// Synchronous state read.
    /// Returns a ResultEnvelope map — { ok: true, v: <encoded-value> } or error envelope.
    public func read(env: AnyMap) throws -> AnyMap {
        let result = BridgeKitNative.shared.delegate.stateRead(env: AnyMapCodec.fromAnyMap(env))
        return try AnyMapCodec.toAnyMap(result)
    }

    // MARK: - observe

    /// Subscribe to state changes. Returns an epoch-scoped obsId.
    /// The onChange closure receives { v: <encoded-value> } envelopes.
    public func observe(env: AnyMap, onChange: @escaping (_ value: AnyMap) -> Void) throws -> String {
        return BridgeKitNative.shared.delegate.stateObserve(
            env: AnyMapCodec.fromAnyMap(env),
            onChange: { valueMap in
                // try? drops the notification on decode failure — Nitro callback closures are non-throwing.
                if let nitroValue = try? AnyMapCodec.toAnyMap(valueMap) {
                    onChange(nitroValue)
                }
            }
        )
    }

    // MARK: - unobserve

    /// Cancel a state observation. No-op if obsId is unknown or stale.
    public func unobserve(obsId: String) throws -> Void {
        BridgeKitNative.shared.delegate.stateUnobserve(obsId: obsId)
    }

    // MARK: - write

    /// Provider-side state write from JS. Returns a ResultEnvelope map.
    public func write(env: AnyMap) throws -> AnyMap {
        let result = BridgeKitNative.shared.delegate.stateWrite(env: AnyMapCodec.fromAnyMap(env))
        return try AnyMapCodec.toAnyMap(result)
    }
}
