// HybridBridgeStreams.swift
// BridgeKit iOS — Nitro Hybrid implementation for BridgeStreams.
//
// CLASS NAME: MUST be HybridBridgeStreams — BridgeKitAutolinking.swift instantiates by exact name.
//
// Requires @_implementationOnly import NitroModules (only available inside the pod build).

@_implementationOnly import NitroModules

/// Nitro Hybrid implementation for BridgeStreams.
/// Delegates all operations to `BridgeKitNative.shared.delegate`.
final class HybridBridgeStreams: HybridBridgeStreamsSpec {

    // `override` (not `required`) — HybridBridgeStreamsSpec_base.init() is not required.
    override init() {
        super.init()
    }

    // MARK: - open

    /// Open a native→JS stream. Returns an epoch-scoped stream id.
    /// Callbacks are held for the epoch lifetime by Nitro's reference-counting.
    func open(
        env: AnyMap,
        onNext: @escaping (_ value: AnyMap) -> Void,
        onEnd: @escaping (_ end: AnyMap) -> Void
    ) throws -> String {
        // Nitro's callback closures are non-throwing, so an encoding failure
        // cannot propagate. It must not be dropped either: a discarded value
        // becomes a silent gap in the consumer's data, and a discarded terminal
        // leaves the consumer waiting on a stream that already ended.
        let terminal = SeamTerminalGuard()

        /// Emit the substitute terminal, if this path won the race to end the stream.
        func endWithEncodingFailure(context: String, error: Error) {
            SeamEncoding.reportFailure(context: context, error: error)
            guard terminal.claim() else { return }
            guard let fallback = try? AnyMapCodec.toAnyMap(
                SeamEncoding.failureTerminal(context: context, error: error)
            ) else { return }
            onEnd(fallback)
        }

        return BridgeKitNative.shared.delegate.openStream(
            env: AnyMapCodec.fromAnyMap(env),
            onNext: { valueMap in
                guard !terminal.isTerminated else { return }
                do {
                    onNext(try AnyMapCodec.toAnyMap(valueMap))
                } catch {
                    // Terminating beats a silent gap: the consumer learns the
                    // stream is broken instead of quietly missing a value.
                    endWithEncodingFailure(context: "stream value", error: error)
                }
            },
            onEnd: { endMap in
                do {
                    let nitroEnd = try AnyMapCodec.toAnyMap(endMap)
                    guard terminal.claim() else { return }
                    onEnd(nitroEnd)
                } catch {
                    endWithEncodingFailure(context: "stream end", error: error)
                }
            }
        )
    }

    // MARK: - close

    /// Cancel a native→JS stream from the JS side.
    /// `throws` is present in the generated protocol signature; this impl never throws.
    func close(streamId: String) throws -> Void {
        BridgeKitNative.shared.delegate.closeStream(streamId: streamId)
    }

    // MARK: - emitFromJs

    /// Push a value from the JS producer to the native consumer.
    /// value follows the { v: <encoded-value> } wire rule.
    func emitFromJs(streamId: String, value: AnyMap) throws -> Void {
        BridgeKitNative.shared.delegate.emitFromJs(
            streamId: streamId,
            value: AnyMapCodec.fromAnyMap(value)
        )
    }

    // MARK: - endFromJs

    /// Signal end-of-stream from the JS producer.
    /// end is a ResultEnvelope map.
    func endFromJs(streamId: String, end: AnyMap) throws -> Void {
        BridgeKitNative.shared.delegate.endFromJs(
            streamId: streamId,
            end: AnyMapCodec.fromAnyMap(end)
        )
    }
}
