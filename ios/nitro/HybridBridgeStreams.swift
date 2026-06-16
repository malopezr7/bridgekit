// HybridBridgeStreams.swift
// BridgeKit iOS — Nitro Hybrid implementation for BridgeStreams.
//
// CLASS NAME: MUST be HybridBridgeStreams — BridgeKitAutolinking.swift instantiates by exact name.
//
// Requires import NitroModules (only available inside the pod build).

import NitroModules

/// Nitro Hybrid implementation for BridgeStreams.
/// Delegates all operations to `BridgeKitNative.shared.delegate`.
public class HybridBridgeStreams: HybridBridgeStreamsSpec {

    // `override` (not `required`) — HybridBridgeStreamsSpec_base.init() is not required.
    public override init() {
        super.init()
    }

    // MARK: - open

    /// Open a native→JS stream. Returns an epoch-scoped stream id.
    /// Callbacks are held for the epoch lifetime by Nitro's reference-counting.
    public func open(
        env: AnyMap,
        onNext: @escaping (_ value: AnyMap) -> Void,
        onEnd: @escaping (_ end: AnyMap) -> Void
    ) throws -> String {
        return BridgeKitNative.shared.delegate.openStream(
            env: AnyMapCodec.fromAnyMap(env),
            onNext: { valueMap in
                // try? drops the event on decode failure — non-throwing closure contract.
                if let nitroValue = try? AnyMapCodec.toAnyMap(valueMap) {
                    onNext(nitroValue)
                }
            },
            onEnd: { endMap in
                if let nitroEnd = try? AnyMapCodec.toAnyMap(endMap) {
                    onEnd(nitroEnd)
                }
            }
        )
    }

    // MARK: - close

    /// Cancel a native→JS stream from the JS side.
    /// `throws` is present in the generated protocol signature; this impl never throws.
    public func close(streamId: String) throws -> Void {
        BridgeKitNative.shared.delegate.closeStream(streamId: streamId)
    }

    // MARK: - emitFromJs

    /// Push a value from the JS producer to the native consumer.
    /// value follows the { v: <encoded-value> } wire rule.
    public func emitFromJs(streamId: String, value: AnyMap) throws -> Void {
        BridgeKitNative.shared.delegate.emitFromJs(
            streamId: streamId,
            value: AnyMapCodec.fromAnyMap(value)
        )
    }

    // MARK: - endFromJs

    /// Signal end-of-stream from the JS producer.
    /// end is a ResultEnvelope map.
    public func endFromJs(streamId: String, end: AnyMap) throws -> Void {
        BridgeKitNative.shared.delegate.endFromJs(
            streamId: streamId,
            end: AnyMapCodec.fromAnyMap(end)
        )
    }
}
