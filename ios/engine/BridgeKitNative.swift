// BridgeKitNative.swift
// BridgeKit iOS engine — singleton seam between Nitro Hybrid objects and the Swift core.
//
// `delegate` defaults to NotReadyDelegate (returns BRIDGE_NOT_READY) and is swapped
// once at startup. NSLock + nonisolated(unsafe) provide thread safety because Nitro
// callbacks arrive on arbitrary threads and the delegate must be settable synchronously
// (an actor would force async access).

import Foundation

// MARK: - BridgeKitNativeDelegate

/// Full delegate surface exposed to the Swift core.
/// All [String: Any?] values conform to the {v: <value>} wire rule.
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

// MARK: - BridgeKitNative singleton

/// Singleton seam — HybridBridgeHost/State/Streams delegate every call here.
public final class BridgeKitNative {

    /// Shared singleton.
    public static let shared = BridgeKitNative()

    // nonisolated(unsafe): set once before Nitro host creation; NSLock guards the window.
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

// MARK: - NotReadyDelegate

private let BRIDGE_NOT_READY_MSG = "BridgeKit native core not initialized. " +
    "Ensure the JS bundle entry imports '@malopezr7/bridgekit' before the first call."

private func notReadyEnvelope() -> [String: Any?] {
    ["ok": false, "code": "BRIDGE_NOT_READY", "message": BRIDGE_NOT_READY_MSG]
}

/// Default delegate — returns BRIDGE_NOT_READY envelopes until the real impl is wired in.
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
