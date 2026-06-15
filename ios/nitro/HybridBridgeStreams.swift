// HybridBridgeStreams.swift
// BridgeKit iOS — Nitro Hybrid implementation for BridgeStreams.
//
// Port of packages/bridgekit/android/src/main/java/com/margelo/nitro/bridgekit/HybridBridgeStreams.kt
//
// CLASS NAME: MUST be HybridBridgeStreams — BridgeKitAutolinking.swift instantiates by exact name.
//
// Requires import NitroModules (only available inside the pod build at L4/L7).

import NitroModules

/// Nitro Hybrid implementation for BridgeStreams.
/// Delegates all operations to `BridgeKitNative.shared.delegate`.
///
/// Port: `class HybridBridgeStreams : HybridBridgeStreamsSpec()` (Kotlin).
public class HybridBridgeStreams: HybridBridgeStreamsSpec {

    // `override` (not `required`) — HybridBridgeStreamsSpec_base.init() is not required.
    public override init() {
        super.init()
    }

    // ---- open ------------------------------------------------------------------

    /// Open a native→JS stream. Returns an epoch-scoped stream id.
    /// Callbacks are held for the epoch lifetime by Nitro's reference-counting.
    ///
    /// Port: `override fun open(env: AnyMap, onNext: (value: AnyMap) -> Unit, onEnd: (end: AnyMap) -> Unit): String` (Kotlin).
    ///
    /// AnyMap conversions:
    ///   env (AnyMap) → AnyMapCodec.fromAnyMap(env) → [String:Any?] for delegate
    ///   onNext valueMap ([String:Any?]) → AnyMapCodec.toAnyMap → AnyMap (for Nitro callback)
    ///   onEnd endMap ([String:Any?]) → AnyMapCodec.toAnyMap → AnyMap (for Nitro callback)
    ///
    /// PORT NOTE: toAnyMap(_:) in the onNext/onEnd closures can throw (INV-11).
    /// Kotlin has no error path in the lambdas — same handling as HybridBridgeState.observe:
    /// use try? and drop the malformed event rather than propagating through a non-throwing closure.
    public func open(
        env: AnyMap,
        onNext: @escaping (_ value: AnyMap) -> Void,
        onEnd: @escaping (_ end: AnyMap) -> Void
    ) throws -> String {
        return BridgeKitNative.shared.delegate.openStream(
            env: AnyMapCodec.fromAnyMap(env),
            onNext: { valueMap in
                // PORT NOTE: Kotlin `onNext(AnyMapCodec.toAnyMap(valueMap))` — no error handling.
                // Swift: try? drops the event on decode failure (codec/schema bug, not runtime error).
                if let nitroValue = try? AnyMapCodec.toAnyMap(valueMap) {
                    onNext(nitroValue)
                }
            },
            onEnd: { endMap in
                // PORT NOTE: same policy as onNext — try? drop on decode failure.
                if let nitroEnd = try? AnyMapCodec.toAnyMap(endMap) {
                    onEnd(nitroEnd)
                }
            }
        )
    }

    // ---- close -----------------------------------------------------------------

    /// Cancel a native→JS stream from the JS side.
    ///
    /// Port: `override fun close(streamId: String)` (Kotlin).
    ///
    /// PORT NOTE: Kotlin's override has no throws. HybridBridgeStreamsSpec_protocol declares
    /// `func close(streamId: String) throws -> Void`. The throws is present in the generated
    /// protocol signature; we conform to it and simply do not throw.
    public func close(streamId: String) throws -> Void {
        BridgeKitNative.shared.delegate.closeStream(streamId: streamId)
    }

    // ---- emitFromJs ------------------------------------------------------------

    /// Push a value from the JS producer to the native consumer.
    /// value follows the { v: <encoded-value> } wire rule.
    ///
    /// Port: `override fun emitFromJs(streamId: String, value: AnyMap)` (Kotlin).
    ///
    /// AnyMap conversion:
    ///   value (AnyMap) → AnyMapCodec.fromAnyMap(value) → [String:Any?] for delegate
    public func emitFromJs(streamId: String, value: AnyMap) throws -> Void {
        BridgeKitNative.shared.delegate.emitFromJs(
            streamId: streamId,
            value: AnyMapCodec.fromAnyMap(value)
        )
    }

    // ---- endFromJs -------------------------------------------------------------

    /// Signal end-of-stream from the JS producer.
    /// end is a ResultEnvelope map.
    ///
    /// Port: `override fun endFromJs(streamId: String, end: AnyMap)` (Kotlin).
    ///
    /// AnyMap conversion:
    ///   end (AnyMap) → AnyMapCodec.fromAnyMap(end) → [String:Any?] for delegate
    public func endFromJs(streamId: String, end: AnyMap) throws -> Void {
        BridgeKitNative.shared.delegate.endFromJs(
            streamId: streamId,
            end: AnyMapCodec.fromAnyMap(end)
        )
    }
}
