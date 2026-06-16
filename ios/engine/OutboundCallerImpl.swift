// OutboundCallerImpl.swift
// BridgeKit iOS engine — OutboundCaller implementation for native→JS calls.
//
// Per-call awaitDispatcher polls until jsCallbacks is non-nil (cooperative, no thread
// blocking). OnceContinuation guards completion/timeout races in invoke().

import Foundation

internal final class OutboundCallerImpl: OutboundCaller {

    private let contractId: String
    private let scope: Scope
    private unowned(unsafe) let router: Router
    private let readinessTimeoutMs: UInt64
    private let callTimeoutMs: UInt64

    private static var streamIdCounter: Int64 = 0
    private static let streamIdLock = NSLock()

    private static func nextStreamId() -> Int64 {
        streamIdLock.lock(); defer { streamIdLock.unlock() }
        streamIdCounter += 1
        return streamIdCounter
    }

    internal init(
        contractId: String,
        scope: Scope,
        router: Router,
        readinessTimeoutMs: UInt64 = 10_000,
        callTimeoutMs: UInt64 = 30_000
    ) {
        self.contractId = contractId
        self.scope = scope
        self.router = router
        self.readinessTimeoutMs = readinessTimeoutMs
        self.callTimeoutMs = callTimeoutMs
    }

    // MARK: - invoke (async)

    public func invoke(member: String, payload: [String: Any?]?) async throws -> Any? {
        let callbacks = try await awaitDispatcher()
        let env = buildEnvelope(op: "invoke", member: member, payload: payload)

        let raw: [String: Any?] = try await withBridgeTimeout(nanoseconds: callTimeoutMs * 1_000_000) {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[String: Any?], Error>) in
                let once = OnceContinuation<[String: Any?]>(cont)
                callbacks.onInvoke(env) { ok, err in
                    if let err = err {
                        once.resume(throwing: BridgeKitError(
                            code: "PROVIDER_ERROR",
                            message: err.localizedDescription,
                            contractId: self.contractId
                        ))
                    } else if let ok = ok {
                        once.resume(returning: ok)
                    } else {
                        once.resume(throwing: BridgeKitError(
                            code: "PROVIDER_ERROR",
                            message: "null result from JS",
                            contractId: self.contractId
                        ))
                    }
                }
            }
        }

        if raw["ok"] as? Bool == true { return raw["value"] }
        throw BridgeKitError.fromEnvelope(raw, contractId: contractId)
    }

    // MARK: - invokeSync

    public func invokeSync(member: String, payload: [String: Any?]?) throws -> Any? {
        throw BridgeKitError(
            code: "NOT_SUPPORTED",
            message: "invokeSync not supported for JS-provided contracts " +
                     "(contract: '\(contractId)', member: '\(member)').",
            contractId: contractId
        )
    }

    // MARK: - fire (fire-and-forget)

    public func fire(member: String, payload: [String: Any?]?) {
        Task { try? await invoke(member: member, payload: payload) }
    }

    // MARK: - stream

    /// Open an AsyncThrowingStream for a JS-provided stream member.
    ///
    /// Router.jsStreamChannels holds the write-side continuation so emitFromJs/endFromJs
    /// can push values into it.
    public func stream(member: String, payload: [String: Any?]?) -> AsyncThrowingStream<Any?, Error> {
        return AsyncThrowingStream<Any?, Error> { continuation in
            Task {
                let callbacks: JsDispatcherCallbacks
                do {
                    callbacks = try await self.awaitDispatcher()
                } catch {
                    continuation.finish(throwing: error)
                    return
                }

                let streamId = "js_\(self.contractId)_\(member)_\(OutboundCallerImpl.nextStreamId())"

                // AsyncStream.makeStream() is iOS 16+; use the closure-based init for iOS 15.1 compat.
                var valCont: AsyncStream<[String: Any?]>.Continuation!
                let valStream = AsyncStream<[String: Any?]> { cont in valCont = cont }

                var endCont: AsyncStream<[String: Any?]>.Continuation!
                let endStream = AsyncStream<[String: Any?]> { cont in endCont = cont }

                self.router.lock.lock()
                self.router.jsStreamChannels[streamId] = (valStream, valCont!)
                self.router.jsStreamEndContinuations[streamId] = endCont!
                self.router.lock.unlock()

                let valuePump = Task {
                    for await valueMap in valStream {
                        continuation.yield(valueMap["v"])
                    }
                }

                let endPump = Task {
                    for await end in endStream {
                        valuePump.cancel()
                        if end["ok"] as? Bool == true {
                            continuation.finish()
                        } else {
                            continuation.finish(throwing: BridgeKitError.fromEnvelope(end, contractId: self.contractId))
                        }
                        return
                    }
                }

                var openEnv = self.buildEnvelope(op: "streamOpen", member: member, payload: payload)
                openEnv["streamId"] = streamId
                callbacks.onStreamOpen(openEnv)

                continuation.onTermination = { _ in
                    valuePump.cancel()
                    endPump.cancel()
                    self.router.lock.lock()
                    self.router.jsStreamChannels.removeValue(forKey: streamId)
                    self.router.jsStreamEndContinuations.removeValue(forKey: streamId)
                    self.router.lock.unlock()
                    let closeEnv: [String: Any?] = ["streamId": streamId, "reason": "native-close"]
                    callbacks.onStreamClose(closeEnv)
                }
            }
        }
    }

    // MARK: - state

    public func state(member: String) -> AsyncStream<BridgeValue<Any?>> {
        return router.stateStore.stateStream(
            contractId: contractId, scope: scope, stateKey: member, initial: nil
        )
    }

    // MARK: - awaitDispatcher

    /// Poll for the JS dispatcher with readiness timeout.
    private func awaitDispatcher() async throws -> JsDispatcherCallbacks {
        if let immediate = router.getJsCallbacks() { return immediate }
        let deadline = DispatchTime.now().uptimeNanoseconds + readinessTimeoutMs * 1_000_000
        while true {
            if let cb = router.getJsCallbacks() { return cb }
            if DispatchTime.now().uptimeNanoseconds >= deadline {
                throw BridgeKitError(
                    code: "BRIDGE_NOT_READY",
                    message: "JS dispatcher not connected within \(readinessTimeoutMs)ms for contract '\(contractId)'",
                    contractId: contractId
                )
            }
            try? await Task.sleep(nanoseconds: 10_000_000)  // 10ms poll
        }
    }

    // MARK: - Envelope builder

    private func buildEnvelope(op: String, member: String, payload: [String: Any?]?) -> [String: Any?] {
        var env: [String: Any?] = [
            "op": op,
            "contractId": contractId,
            "member": member,
            "scope": Router.scopeToEnvMap(scope),
            "correlationId": "native_\(mach_absolute_time())",
            "epoch": router.currentEpoch()
        ]
        if let p = payload { env["payload"] = p }
        return env
    }
}

// MARK: - withBridgeTimeout

/// Run an async closure with a timeout.
internal func withBridgeTimeout<T>(
    nanoseconds: UInt64,
    operation: @escaping () async throws -> T
) async throws -> T {
    return try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: nanoseconds)
            throw BridgeKitError(code: "TIMEOUT", message: "Call timed out", contractId: nil)
        }
        let result = try await group.next()!
        group.cancelAll()
        return result
    }
}

// MARK: - BridgeKitError

/// Swift engine error type.
public struct BridgeKitError: Error, CustomStringConvertible {
    public let code: String
    public let message: String
    public let contractId: String?
    public let member: String?

    public init(code: String, message: String, contractId: String? = nil, member: String? = nil) {
        self.code = code
        self.message = message
        self.contractId = contractId
        self.member = member
    }

    public var description: String { "BridgeKitError(\(code)): \(message)" }

    static func fromEnvelope(_ env: [String: Any?], contractId: String? = nil) -> BridgeKitError {
        BridgeKitError(
            code: env["code"] as? String ?? "UNKNOWN",
            message: env["message"] as? String ?? "Unknown error",
            contractId: contractId ?? env["contractId"] as? String
        )
    }
}
