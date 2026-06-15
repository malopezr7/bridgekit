// BridgeKitNative.swift
// BridgeKit iOS engine — singleton seam between the Nitro Hybrid objects (L3) and
// the BridgeKit Swift core (L2).
//
// Port of io/github/malopezr7/bridgekit/runtime/BridgeKitNative.kt
//
// DESIGN:
//  - `delegate` is the mutable seam. Default = NotReadyDelegate (returns BRIDGE_NOT_READY).
//  - `nonisolated(unsafe)` on the backing storage + NSLock protection: Nitro callbacks
//    arrive on arbitrary threads before the engine is set.
//  - NOT an actor (would force async access to a var that must be set synchronously).
//
// PORT NOTE: Kotlin `@Volatile var delegate` is a straightforward atomic assignment.
// Swift does not have `@Volatile` or atomic properties on reference types.
// Strategy: NSLock-protected backing + nonisolated(unsafe) storage.
// The set path is: lock → assign → unlock.
// The read path (Nitro callbacks): lock → read → unlock → call.
// This matches the Kotlin semantics where reads/writes are atomic.

import Foundation

// ---- BridgeKitNativeDelegate protocol --------------------------------------

/// Full delegate surface exposed to the Swift core.
/// All [String: Any?] values conform to the {v: <value>} wire rule.
///
/// Port: `interface BridgeKitNativeDelegate` (Kotlin).
public protocol BridgeKitNativeDelegate: AnyObject {

    // BridgeHost
    func invoke(env: [String: Any?], complete: @escaping ([String: Any?]) -> Void)
    func invokeSync(env: [String: Any?]) -> [String: Any?]
    func connectDispatcher(epochInfo: [String: Any?], callbacks: JsDispatcherCallbacks) -> [String: Any?]

    // BridgeStreams
    func openStream(env: [String: Any?], onNext: @escaping ([String: Any?]) -> Void, onEnd: @escaping ([String: Any?]) -> Void) -> String
    func closeStream(streamId: String)
    func emitFromJs(streamId: String, value: [String: Any?])
    func endFromJs(streamId: String, end: [String: Any?])

    // BridgeState
    func stateRead(env: [String: Any?]) -> [String: Any?]
    func stateObserve(env: [String: Any?], onChange: @escaping ([String: Any?]) -> Void) -> String
    func stateUnobserve(obsId: String)
    func stateWrite(env: [String: Any?]) -> [String: Any?]
}

// ---- BridgeKitNative singleton ---------------------------------------------

/// Singleton seam. HybridBridgeHost/State/Streams (L3) delegate every call here.
///
/// Port: `object BridgeKitNative` (Kotlin).
public final class BridgeKitNative {

    /// Shared singleton.
    public static let shared = BridgeKitNative()

    // nonisolated(unsafe): delegate is set once before the Nitro host is created.
    // Lock protects the assignment window (concurrent set + read during startup).
    //
    // PORT NOTE: Kotlin `@Volatile var delegate` — Swift nonisolated(unsafe) + NSLock.
    // `nonisolated(unsafe)` suppresses the actor-isolation warning on global-actor-less
    // types. The NSLock provides the actual thread safety.
    private let _lock = NSLock()
    nonisolated(unsafe) private var _delegate: BridgeKitNativeDelegate = NotReadyDelegate.shared

    private init() {}

    /// Get/set the active delegate.
    ///
    /// Thread-safe: NSLock-protected. Set BEFORE Nitro host initialization.
    public var delegate: BridgeKitNativeDelegate {
        get {
            _lock.lock(); defer { _lock.unlock() }
            return _delegate
        }
        set {
            _lock.lock()
            _delegate = newValue
            _lock.unlock()
        }
    }
}

// ---- NotReadyDelegate ------------------------------------------------------

private let BRIDGE_NOT_READY_MSG = "BridgeKit native core not initialized. " +
    "Ensure the JS bundle entry imports '@malopezr7/bridgekit' before the first call."

private func notReadyEnvelope() -> [String: Any?] {
    ["ok": false, "code": "BRIDGE_NOT_READY", "message": BRIDGE_NOT_READY_MSG]
}

/// Default delegate — returns BRIDGE_NOT_READY envelopes until BridgeKit wires in the real impl.
///
/// Port: `object NotReadyDelegate` (Kotlin).
public final class NotReadyDelegate: BridgeKitNativeDelegate {

    public static let shared = NotReadyDelegate()
    private init() {}

    public func invoke(env: [String: Any?], complete: @escaping ([String: Any?]) -> Void) {
        complete(notReadyEnvelope())
    }

    public func invokeSync(env: [String: Any?]) -> [String: Any?] {
        notReadyEnvelope()
    }

    public func connectDispatcher(epochInfo: [String: Any?], callbacks: JsDispatcherCallbacks) -> [String: Any?] {
        ["epoch": 0, "snapshot": [] as [[String: Any?]]]
    }

    public func openStream(
        env: [String: Any?],
        onNext: @escaping ([String: Any?]) -> Void,
        onEnd: @escaping ([String: Any?]) -> Void
    ) -> String {
        onEnd(notReadyEnvelope())
        return ""
    }

    public func closeStream(streamId: String) {}
    public func emitFromJs(streamId: String, value: [String: Any?]) {}
    public func endFromJs(streamId: String, end: [String: Any?]) {}

    public func stateRead(env: [String: Any?]) -> [String: Any?] { notReadyEnvelope() }
    public func stateObserve(env: [String: Any?], onChange: @escaping ([String: Any?]) -> Void) -> String { "" }
    public func stateUnobserve(obsId: String) {}
    public func stateWrite(env: [String: Any?]) -> [String: Any?] { notReadyEnvelope() }
}
