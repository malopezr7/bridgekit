// HybridBridgeHost.swift
// BridgeKit iOS — Nitro Hybrid implementation for BridgeHost.
//
// Port of packages/bridgekit/android/src/main/java/com/margelo/nitro/bridgekit/HybridBridgeHost.kt
//
// CLASS NAME: MUST be HybridBridgeHost — BridgeKitAutolinking.swift instantiates by exact name.
// A rename here silently breaks Nitro autolinking.
//
// Requires import NitroModules (only available inside the pod build at L4/L7).

import NitroModules

// ---- Double-Promise adapter (connectDispatcher / onInvoke) -------------------------
//
// Nitro generates `onInvoke` as:
//   (AnyMap) -> Promise<Promise<AnyMap>>
//
// Why two layers?
//   1. The JS callback is itself async → inner Promise<AnyMap> resolves when JS finishes.
//   2. Nitro wraps the cross-thread dispatch in another Promise → outer layer.
//
// We bridge this to JsDispatcherCallbacks.onInvoke's completion-callback API:
//   - Start a detached Task (keeps awaiting off the JS thread).
//   - `try await onInvoke(nitroEnv).await().await()` peels both layers.
//   - Call completion exactly once regardless of success or throw (do/catch wrapper).
//
// PORT NOTE (Kotlin vs Swift await):
//   Kotlin:  `val outerPromise = onInvoke(nitroEnv); val innerPromise = outerPromise.await();
//             val resultAnyMap = innerPromise.await()`
//   Swift:   `try await onInvoke(nitroEnv).await().await()`
//   The call chains are semantically identical. Swift's Promise.await() is an async function
//   that suspends the Task until the Promise resolves or rejects; chaining .await() on the
//   already-awaited Promise<AnyMap> peels the inner layer. Verified against Nitro Swift API
//   documented in the explore artifact (observation #1124).
//
// PORT NOTE (completion exactly-once):
//   Kotlin wraps the two-await chain in try/catch → completion(result, null) or (null, err).
//   Swift mirrors this identically: do { ... completion(result, nil) } catch { completion(nil, e) }.
//   The completion closure is a native Swift closure (not a Kotlin SAM); the semantics are the same.
// ------------------------------------------------------------------------------------

public class HybridBridgeHost: HybridBridgeHostSpec {

    // HybridBridgeHostSpec is a typealias:
    //   HybridBridgeHostSpec_protocol & HybridBridgeHostSpec_base
    // super.init() comes from HybridBridgeHostSpec_base (open class with `public init() {}`).
    // `override` (not `required`) because the base class init is not marked required.
    // Pattern confirmed by NitroActions sibling implementations (HybridCountryModule et al.).
    public override init() {
        super.init()
    }

    // ---- invoke ----------------------------------------------------------------

    /// Async invoke — returns a Promise resolved when the delegate's completion fires.
    ///
    /// Port: `override fun invoke(env: AnyMap): Promise<AnyMap> = Promise.async { ... }` (Kotlin).
    ///
    /// PORT NOTE: Kotlin `Promise.async {}` is a coroutine builder that suspends inside.
    /// Swift `Promise.async { try await ... }` is the direct equivalent per Nitro Swift API.
    /// The delegate's completion callback pattern (Kotlin side) is adapted to a
    /// CheckedContinuation on the Swift side via withCheckedThrowingContinuation, then resolved
    /// via the completion closure.
    ///
    /// AnyMap conversions:
    ///   env (AnyMap in) → AnyMapCodec.fromAnyMap(env) → [String:Any?] for delegate
    ///   result ([String:Any?] out) → AnyMapCodec.toAnyMap(result) → AnyMap for Nitro
    public func invoke(env: AnyMap) throws -> Promise<AnyMap> {
        return Promise.async {
            let envMap = AnyMapCodec.fromAnyMap(env)

            // Suspend until the delegate fires the completion callback.
            // withCheckedThrowingContinuation is the Swift equivalent of Kotlin's
            // CompletableDeferred / suspendCoroutine used inside Promise.async.
            let resultMap: [String: Any?] = try await withCheckedThrowingContinuation { continuation in
                BridgeKitNative.shared.delegate.invoke(env: envMap) { result in
                    continuation.resume(returning: result)
                }
            }

            return try AnyMapCodec.toAnyMap(resultMap)
        }
    }

    // ---- invokeSync ------------------------------------------------------------

    /// Synchronous invoke — blocks the calling thread until delegate returns.
    ///
    /// Port: `override fun invokeSync(env: AnyMap): AnyMap` (Kotlin).
    ///
    /// AnyMap conversions:
    ///   env (AnyMap) → AnyMapCodec.fromAnyMap(env) → [String:Any?] for delegate
    ///   result ([String:Any?]) → AnyMapCodec.toAnyMap(result) → AnyMap for Nitro
    public func invokeSync(env: AnyMap) throws -> AnyMap {
        let envMap  = AnyMapCodec.fromAnyMap(env)
        let result  = BridgeKitNative.shared.delegate.invokeSync(env: envMap)
        return try AnyMapCodec.toAnyMap(result)
    }

    // ---- connectDispatcher -----------------------------------------------------

    /// Register the JS dispatcher. Synchronous — returns epoch + snapshot envelope.
    ///
    /// Port: `override fun connectDispatcher(...): AnyMap` (Kotlin).
    ///
    /// The onInvoke closure has Nitro's double-Promise signature:
    ///   (AnyMap) -> Promise<Promise<AnyMap>>
    /// This is adapted to JsDispatcherCallbacks.onInvoke's completion-callback form.
    /// See "Double-Promise adapter" comment block at the top of this file.
    ///
    /// AnyMap conversions:
    ///   epochInfo (AnyMap) → AnyMapCodec.fromAnyMap(epochInfo) → [String:Any?]
    ///   onInvoke env arg: [String:Any?] → AnyMapCodec.toAnyMap → AnyMap (for Nitro callback)
    ///   onInvoke result: AnyMap → AnyMapCodec.fromAnyMap → [String:Any?] (for completion)
    ///   onStreamOpen/Close/StateWrite env: [String:Any?] → AnyMapCodec.toAnyMap → AnyMap
    ///   return ([String:Any?]) → AnyMapCodec.toAnyMap → AnyMap
    public func connectDispatcher(
        epochInfo: AnyMap,
        onInvoke: @escaping (_ env: AnyMap) -> Promise<Promise<AnyMap>>,
        onStreamOpen: @escaping (_ env: AnyMap) -> Void,
        onStreamClose: @escaping (_ env: AnyMap) -> Void,
        onStateWrite: @escaping (_ env: AnyMap) -> Void
    ) throws -> AnyMap {
        let callbacks = JsDispatcherCallbacks(
            onInvoke: { envMap, completion in
                // Convert [String:Any?] → AnyMap for the Nitro onInvoke closure.
                //
                // PORT NOTE: AnyMapCodec.toAnyMap(_:) throws on incompatible values (INV-11).
                // If the conversion itself fails we treat it as an error completion.
                // This mirrors Kotlin's implicit throw-propagation into the catch block.
                let nitroEnv: AnyMap
                do {
                    nitroEnv = try AnyMapCodec.toAnyMap(envMap)
                } catch {
                    completion(nil, error)
                    return
                }

                // Detach a Task so the two-await chain runs off the current thread.
                //
                // PORT NOTE (Kotlin vs Swift):
                //   Kotlin: `Promise.async { ... }` — coroutine, non-blocking.
                //   Swift:  `Task { ... }` — cooperative async Task, non-blocking.
                //   Both detach from the caller; both allow `.await()` / `suspend` inside.
                Task {
                    do {
                        // Double-await: peel Nitro's outer transport Promise, then the JS async inner Promise.
                        // Kotlin: outerPromise.await() → innerPromise.await()
                        // Swift:  try await onInvoke(nitroEnv).await().await()
                        //
                        // PORT NOTE: Promise<T>.await() in Nitro Swift is an async function
                        // that suspends until the Promise settles (resolve or reject).
                        // Chaining .await() directly on the result is valid because
                        // `onInvoke(nitroEnv)` returns `Promise<Promise<AnyMap>>` and
                        // `.await()` on it returns `Promise<AnyMap>`, which `.await()` again
                        // gives the final `AnyMap`.
                        let resultAnyMap = try await onInvoke(nitroEnv).await().await()

                        // Convert AnyMap back to [String:Any?] for the delegate completion.
                        let resultMap = AnyMapCodec.fromAnyMap(resultAnyMap)
                        completion(resultMap, nil)
                    } catch {
                        // Completion called EXACTLY once — even on throw.
                        // Port: `catch (err: Throwable) { completion(null, err) }` (Kotlin).
                        completion(nil, error)
                    }
                }
            },
            onStreamOpen: { envMap in
                // PORT NOTE: Nitro callbacks receive [String:Any?]; Nitro closure expects AnyMap.
                // toAnyMap(_:) can throw; per Kotlin port we swallow the error here because
                // the Kotlin side also has no error-handling path for onStreamOpen.
                // A decode failure here is a codegen bug (schema mismatch), not a runtime error.
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
