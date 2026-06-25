// HybridBridgeHost.swift
// BridgeKit iOS — Nitro Hybrid implementation for BridgeHost.
//
// CLASS NAME: MUST be HybridBridgeHost — BridgeKitAutolinking.swift instantiates by exact name.
// A rename here silently breaks Nitro autolinking.
//
// Requires @_implementationOnly import NitroModules (only available inside the pod build).

@_implementationOnly import NitroModules

// Double-Promise adapter (connectDispatcher / onInvoke)
//
// Nitro generates `onInvoke` as (AnyMap) -> Promise<Promise<AnyMap>>:
//   - Inner Promise<AnyMap> resolves when JS finishes.
//   - Outer Promise wraps the cross-thread Nitro dispatch.
//
// Bridged to JsDispatcherCallbacks.onInvoke's completion-callback API via a
// detached Task that peels both layers with `.await().await()` and calls
// completion exactly once (do/catch wrapper).

final class HybridBridgeHost: HybridBridgeHostSpec {

    // `override` (not `required`) — HybridBridgeHostSpec_base.init() is not required.
    override init() {
        super.init()
    }

    // MARK: - invoke

    /// Async invoke — returns a Promise resolved when the delegate's completion fires.
    func invoke(env: AnyMap) throws -> Promise<AnyMap> {
        return Promise.async {
            let envMap = AnyMapCodec.fromAnyMap(env)

            // Suspend until the delegate fires the completion callback.
            let resultMap: [String: Any?] = try await withCheckedThrowingContinuation { continuation in
                BridgeKitNative.shared.delegate.invoke(env: envMap) { result in
                    continuation.resume(returning: result)
                }
            }

            return try AnyMapCodec.toAnyMap(resultMap)
        }
    }

    // MARK: - invokeSync

    /// Synchronous invoke — blocks the calling thread until delegate returns.
    func invokeSync(env: AnyMap) throws -> AnyMap {
        let envMap  = AnyMapCodec.fromAnyMap(env)
        let result  = BridgeKitNative.shared.delegate.invokeSync(env: envMap)
        return try AnyMapCodec.toAnyMap(result)
    }

    // MARK: - connectDispatcher

    /// Register the JS dispatcher. Synchronous — returns epoch + snapshot envelope.
    /// onInvoke uses Nitro's double-Promise signature — see the Double-Promise adapter
    /// comment at the top of this file.
    func connectDispatcher(
        epochInfo: AnyMap,
        onInvoke: @escaping (_ env: AnyMap) -> Promise<Promise<AnyMap>>,
        onStreamOpen: @escaping (_ env: AnyMap) -> Void,
        onStreamClose: @escaping (_ env: AnyMap) -> Void,
        onStateWrite: @escaping (_ env: AnyMap) -> Void
    ) throws -> AnyMap {
        let callbacks = JsDispatcherCallbacks(
            onInvoke: { envMap, completion in
                // If env conversion fails, surface it as an error completion immediately.
                let nitroEnv: AnyMap
                do {
                    nitroEnv = try AnyMapCodec.toAnyMap(envMap)
                } catch {
                    completion(nil, error)
                    return
                }

                // Detach a Task so the two-await chain runs off the current thread.
                Task {
                    do {
                        // Double-await: peel Nitro's outer transport Promise, then the JS async inner Promise.
                        let resultAnyMap = try await onInvoke(nitroEnv).await().await()
                        let resultMap = AnyMapCodec.fromAnyMap(resultAnyMap)
                        completion(resultMap, nil)
                    } catch {
                        // Completion called exactly once — even on throw.
                        completion(nil, error)
                    }
                }
            },
            onStreamOpen: { envMap in
                // try? drops the event on decode failure — no error path in these callbacks.
                if let nitroEnv = try? AnyMapCodec.toAnyMap(envMap) {
                    onStreamOpen(nitroEnv)
                }
            },
            onStreamClose: { envMap in
                if let nitroEnv = try? AnyMapCodec.toAnyMap(envMap) {
                    onStreamClose(nitroEnv)
                }
            },
            onStateWrite: { envMap in
                if let nitroEnv = try? AnyMapCodec.toAnyMap(envMap) {
                    onStateWrite(nitroEnv)
                }
            }
        )

        let epochMap  = AnyMapCodec.fromAnyMap(epochInfo)
        let result    = BridgeKitNative.shared.delegate.connectDispatcher(
            epochInfo: epochMap,
            callbacks: callbacks
        )
        return try AnyMapCodec.toAnyMap(result)
    }
}
