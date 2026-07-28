// HybridBridgeState.swift
// BridgeKit iOS — Nitro Hybrid implementation for BridgeState.
//
// CLASS NAME: MUST be HybridBridgeState — BridgeKitAutolinking.swift instantiates by exact name.
//
// Requires @_implementationOnly import NitroModules (only available inside the pod build).

@_implementationOnly import NitroModules

/// Nitro Hybrid implementation for BridgeState.
/// Delegates all operations to `BridgeKitNative.shared.delegate`.
final class HybridBridgeState: HybridBridgeStateSpec {

    // `override` (not `required`) — HybridBridgeStateSpec_base.init() is not required.
    override init() {
        super.init()
    }

    // MARK: - read

    /// Synchronous state read.
    /// Returns a ResultEnvelope map — { ok: true, v: <encoded-value> } or error envelope.
    func read(env: AnyMap) throws -> AnyMap {
        let result = BridgeKitNative.shared.delegate.stateRead(env: AnyMapCodec.fromAnyMap(env))
        return try AnyMapCodec.toAnyMap(result)
    }

    // MARK: - observe

    /// Subscribe to state changes. Returns an epoch-scoped obsId.
    /// The onChange closure receives { v: <encoded-value> } envelopes.
    func observe(env: AnyMap, onChange: @escaping (_ value: AnyMap) -> Void) throws -> String {
        return BridgeKitNative.shared.delegate.stateObserve(
            env: AnyMapCodec.fromAnyMap(env),
            // A state notification has no terminal to substitute, and dropping it
            // silently leaves the consumer on a stale value with no signal. There
            // is no error channel here, so report it: iOS has no diagnostics
            // module yet, and SeamEncoding.reportFailure is the single place to
            // redirect once it does.
            onChange: { valueMap in
                do {
                    onChange(try AnyMapCodec.toAnyMap(valueMap))
                } catch {
                    SeamEncoding.reportFailure(context: "state change", error: error)
                }
            }
        )
    }

    // MARK: - unobserve

    /// Cancel a state observation. No-op if obsId is unknown or stale.
    func unobserve(obsId: String) throws -> Void {
        BridgeKitNative.shared.delegate.stateUnobserve(obsId: obsId)
    }

    // MARK: - write

    /// Provider-side state write from JS. Returns a ResultEnvelope map.
    func write(env: AnyMap) throws -> AnyMap {
        let result = BridgeKitNative.shared.delegate.stateWrite(env: AnyMapCodec.fromAnyMap(env))
        return try AnyMapCodec.toAnyMap(result)
    }
}
