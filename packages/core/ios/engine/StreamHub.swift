// StreamHub.swift
// BridgeKit iOS engine — multiplexes one provider AsyncStream across N consumers.

import Foundation

// MARK: - Hub sentinels

/// Sentinel: upstream completed normally.
internal final class HubTerminalOK {}
internal let HUB_TERMINAL_OK = HubTerminalOK()

/// Upstream completed with an error.
internal struct HubTerminalError {
    let message: String
}

/// Union type for a hub terminal signal.
internal enum HubTerminal {
    case ok
    case error(String)
}

// MARK: - StreamHub

internal final class StreamHub {

    private struct HubKey: Hashable {
        let contractId: String
        let member: String
        let scopeKey: String
        let paramsHash: Int64
    }

    /// State for one active upstream.
    private final class HubEntry {
        /// Per-consumer callbacks keyed by UUID.
        /// onNext receives the raw value (Any?); terminal delivery is separate.
        var consumers: [UUID: (Any?) -> Void] = [:]
        var onEndCallbacks: [UUID: ([String: Any?]) -> Void] = [:]
        var terminalFiredFor: Set<UUID> = []

        var upstreamTask: Task<Void, Never>? = nil

        /// Set BEFORE fan-out. Late consumer checks this under the lock.
        var terminalResult: HubTerminal? = nil

        var replayLatest: Any?? = nil  // nil = no replay; .some(nil) = last was nil
        var hasReplay: Bool = false
    }

    // All hub state is guarded by the engine NSRecursiveLock passed at init.
    private var hubs: [HubKey: HubEntry] = [:]

    /// Borrows the engine lock for all mutations (lock hierarchy: engineLock → streamHub state).
    /// Upstream Tasks fan out OUTSIDE the lock.
    private unowned(unsafe) let lock: NSRecursiveLock

    internal init(lock: NSRecursiveLock) {
        self.lock = lock
    }

    // MARK: - attach

    /// Attach a consumer to the shared stream for (contractId, member, scope, paramsHash).
    ///
    /// Returns a `Task<Void, Never>` that the caller stores in streamPumpJobs. Cancelling
    /// it detaches this consumer from the hub and releases the upstream when the last
    /// consumer leaves.
    ///
    /// Called UNDER the engine lock (Router holds the lock during openStream).
    @discardableResult
    internal func attach(
        contractId: String,
        member: String,
        scope: Scope,
        paramsHash: Int64,
        openStream: @escaping () -> AsyncThrowingStream<Any?, Error>,
        latestOnly: Bool = false,
        sticky: Bool = false,
        onNext: @escaping ([String: Any?]) -> Void,
        onEnd: @escaping ([String: Any?]) -> Void
    ) -> Task<Void, Never> {
        let key = HubKey(
            contractId: contractId,
            member: member,
            scopeKey: scope.serialized(),
            paramsHash: paramsHash
        )
        let consumerID = UUID()

        // getOrCreate the HubEntry — first caller starts the upstream.
        let entry: HubEntry
        if let existing = hubs[key] {
            entry = existing
        } else {
            let newEntry = HubEntry()
            hubs[key] = newEntry
            entry = newEntry
        }

        // Register consumer before starting upstream to avoid missing early emissions.
        entry.consumers[consumerID] = { [weak entry] value in
            // Called OUTSIDE the engine lock by the upstream Task.
            guard let entry = entry else { return }
            onNext(["v": value])
            // Store replay if needed
            if latestOnly || sticky {
                entry.replayLatest = .some(value)
                entry.hasReplay = true
            }
        }
        entry.onEndCallbacks[consumerID] = onEnd

        // If upstream already terminated, deliver the terminal inline to this late consumer.
        // Schedule as an async Task to avoid reentrancy (caller holds the lock).
        if let terminal = entry.terminalResult {
            entry.terminalFiredFor.insert(consumerID)
            let terminalEnv = Self.terminalEnv(terminal, contractId: contractId, member: member, scope: scope)
            entry.consumers.removeValue(forKey: consumerID)
            entry.onEndCallbacks.removeValue(forKey: consumerID)
            return Task {
                onEnd(terminalEnv)
            }
        }

        // replay=1: deliver last known value to late subscriber.
        if (latestOnly || sticky) && entry.hasReplay {
            if let replayVal = entry.replayLatest {
                onNext(["v": replayVal])
            } else {
                onNext(["v": Optional<Any>.none as Any?])
            }
        }

        // Start the upstream Task exactly once (for the first attaching consumer).
        if entry.upstreamTask == nil || entry.upstreamTask?.isCancelled == true {
            let capturedKey = key
            entry.upstreamTask = Task {
                do {
                    let stream = openStream()
                    for try await value in stream {
                        // Fan out OUTSIDE the engine lock.
                        // Snapshot consumers under a brief lock acquisition.
                        let snapshot: [(UUID, (Any?) -> Void)]
                        self.lock.lock()
                        snapshot = Array(self.hubs[capturedKey]?.consumers ?? [:])
                        // Store replay
                        if let e = self.hubs[capturedKey] {
                            if latestOnly || sticky {
                                e.replayLatest = .some(value)
                                e.hasReplay = true
                            }
                        }
                        self.lock.unlock()
                        for (_, cb) in snapshot {
                            cb(value)
                        }
                    }
                    // Normal completion — set terminalResult BEFORE fan-out.
                    self.lock.lock()
                    if let e = self.hubs[capturedKey] {
                        e.terminalResult = .ok
                    }
                    let endSnapshot: [(UUID, ([String: Any?]) -> Void)]
                    let firedSnapshot: Set<UUID>
                    if let e = self.hubs[capturedKey] {
                        endSnapshot = Array(e.onEndCallbacks)
                        firedSnapshot = e.terminalFiredFor
                        e.consumers.removeAll()
                        e.onEndCallbacks.removeAll()
                    } else {
                        endSnapshot = []
                        firedSnapshot = []
                    }
                    // Identity-checked remove.
                    if let e = self.hubs[capturedKey], self.hubs[capturedKey] === e {
                        self.hubs.removeValue(forKey: capturedKey)
                    }
                    self.lock.unlock()
                    let termEnv: [String: Any?] = ["ok": true, "value": nil]
                    for (id, cb) in endSnapshot where !firedSnapshot.contains(id) {
                        cb(termEnv)
                    }
                } catch is CancellationError {
                    // Cooperative cancel — no terminal emitted.
                    self.lock.lock()
                    if let e = self.hubs[capturedKey], self.hubs[capturedKey] === e {
                        self.hubs.removeValue(forKey: capturedKey)
                    }
                    self.lock.unlock()
                } catch {
                    // Upstream error — set terminalResult BEFORE fan-out.
                    let msg = error.localizedDescription
                    self.lock.lock()
                    if let e = self.hubs[capturedKey] {
                        e.terminalResult = .error(msg)
                    }
                    let endSnapshot: [(UUID, ([String: Any?]) -> Void)]
                    let firedSnapshot: Set<UUID>
                    if let e = self.hubs[capturedKey] {
                        endSnapshot = Array(e.onEndCallbacks)
                        firedSnapshot = e.terminalFiredFor
                        e.consumers.removeAll()
                        e.onEndCallbacks.removeAll()
                    } else {
                        endSnapshot = []
                        firedSnapshot = []
                    }
                    // Identity-checked remove.
                    if let e = self.hubs[capturedKey], self.hubs[capturedKey] === e {
                        self.hubs.removeValue(forKey: capturedKey)
                    }
                    self.lock.unlock()
                    let termEnv: [String: Any?] = [
                        "ok": false,
                        "code": "PROVIDER_ERROR",
                        "message": msg,
                        "contractId": contractId,
                        "member": member,
                        "scope": ["kind": scope.serialized()]
                    ]
                    for (id, cb) in endSnapshot where !firedSnapshot.contains(id) {
                        cb(termEnv)
                    }
                }
            }
        }

        // Return a Task that represents this consumer's lifetime.
        // Cancelling this Task detaches the consumer.
        let capturedKey = key
        let consumerTask = Task<Void, Never> {
            await withTaskCancellationHandler {
                try? await Task.sleep(nanoseconds: .max)
            } onCancel: {
                self.lock.lock()
                if let e = self.hubs[capturedKey] {
                    e.consumers.removeValue(forKey: consumerID)
                    e.onEndCallbacks.removeValue(forKey: consumerID)
                    if e.consumers.isEmpty {
                        e.upstreamTask?.cancel()
                        if self.hubs[capturedKey] === e {
                            self.hubs.removeValue(forKey: capturedKey)
                        }
                    }
                }
                self.lock.unlock()
            }
        }

        return consumerTask
    }

    // MARK: - detach

    /// Cancel upstream when the last consumer leaves.
    internal func detach(contractId: String, member: String, scope: Scope, paramsHash: Int64, consumerID: UUID) {
        let key = HubKey(
            contractId: contractId,
            member: member,
            scopeKey: scope.serialized(),
            paramsHash: paramsHash
        )
        guard let entry = hubs[key] else { return }
        entry.consumers.removeValue(forKey: consumerID)
        entry.onEndCallbacks.removeValue(forKey: consumerID)
        if entry.consumers.isEmpty {
            entry.upstreamTask?.cancel()
            if hubs[key] === entry { hubs.removeValue(forKey: key) }
        }
    }

    // MARK: - cancelAll

    /// Cancel all active hub entries — called on epoch swap.
    internal func cancelAll() {
        for (_, entry) in hubs {
            entry.upstreamTask?.cancel()
        }
        hubs.removeAll()
    }

    // MARK: - Helpers

    private static func terminalEnv(
        _ terminal: HubTerminal,
        contractId: String,
        member: String,
        scope: Scope
    ) -> [String: Any?] {
        switch terminal {
        case .ok:
            return ["ok": true, "value": nil]
        case .error(let msg):
            return [
                "ok": false,
                "code": "PROVIDER_ERROR",
                "message": msg,
                "contractId": contractId,
                "member": member,
                "scope": ["kind": scope.serialized()]
            ]
        }
    }
}

// MARK: - AsyncStream.map extension

// `AsyncStream.map` is not in the Swift stdlib. Placed here so the engine and
// generated code can use it without importing NitroModules.
extension AsyncStream {
    /// Returns a new AsyncStream whose elements are the results of applying the
    /// given transform to each element of this stream.
    public func map<T>(_ transform: @escaping (Element) async -> T) -> AsyncStream<T> {
        var iterator = makeAsyncIterator()
        return AsyncStream<T> { continuation in
            Task {
                while let element = await iterator.next() {
                    let transformed = await transform(element)
                    continuation.yield(transformed)
                }
                continuation.finish()
            }
        }
    }
}

extension AsyncThrowingStream {
    /// Returns a new AsyncThrowingStream whose elements are the results of applying
    /// the given transform to each element of this stream.
    public func map<T>(_ transform: @escaping (Element) async throws -> T) -> AsyncThrowingStream<T, Error> {
        var iterator = makeAsyncIterator()
        return AsyncThrowingStream<T, Error> { continuation in
            Task {
                do {
                    while let element = try await iterator.next() {
                        let transformed = try await transform(element)
                        continuation.yield(transformed)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}
