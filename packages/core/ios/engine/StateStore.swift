// StateStore.swift
// BridgeKit iOS engine — bidirectional state store.
//
// Lock-guarded BridgeValue + per-observer callback list. Not an actor (sync reads
// required). Replacing → Unprovided after a grace window (replacingGraceMs, default 250ms);
// grace Task cancelled on re-provision or seedNativeState.
// notifyObserversGone sends {"status":"gone"} WITHOUT "v" — JS sees undefined → stale branch.

import Foundation

internal final class StateStore {

    /// Duration in ms that state entries remain in Replacing state before → Unprovided.
    internal let replacingGraceMs: UInt64  // nanoseconds internally; ms at API surface

    private struct StoreKey: Hashable {
        let contractId: String
        let stateKey: String
        let scopeKey: String
    }

    // All state guarded by the engine NSRecursiveLock (shared with Router).
    private var states: [StoreKey: BridgeValue<Any?>] = [:]

    // Grace-window Task handles; cancelled on re-provision or seedNativeState.
    private var graceJobs: [String: Task<Void, Never>] = [:]  // StoreKey.description → Task

    // Observer registry.
    private struct Observer {
        let contractId: String
        let stateKey: String
        let scopeKey: String
        let onChange: ([String: Any?]) -> Void
        let epoch: Int64
    }

    private var observers: [String: Observer] = [:]
    private var obsCounter: Int64 = 0

    // Borrowed reference to the engine lock.
    private unowned(unsafe) let lock: NSRecursiveLock

    internal init(lock: NSRecursiveLock, replacingGraceMs: UInt64 = 250) {
        self.lock = lock
        self.replacingGraceMs = replacingGraceMs
    }

    // MARK: - Native-provided seeding

    /// Seed the store with an initial value for a native-provided contract.
    /// Also cancels any active grace job for this key.
    internal func seedNativeState(contractId: String, scope: Scope, stateKey: String, initial: Any?) {
        let key = StoreKey(contractId: contractId, stateKey: stateKey, scopeKey: scope.serialized())
        let keyStr = keyString(key)
        graceJobs.removeValue(forKey: keyStr)?.cancel()
        states[key] = .available(initial)
    }

    /// Update a native state entry. Notifies observers inline (caller must NOT hold the engine lock).
    /// For locked paths, use setNativeValueUnderLock + snapshotObserversInternal instead.
    internal func setNativeValue(contractId: String, scope: Scope, stateKey: String, value: Any?) {
        let key = StoreKey(contractId: contractId, stateKey: stateKey, scopeKey: scope.serialized())
        states[key] = .available(value)
        let snapshot = snapshotObservers(contractId: contractId, stateKey: stateKey, scope: scope)
        notifyObservers(snapshot: snapshot, env: ["v": value])
    }

    /// Write native state. Lock must be held; caller must snapshot + notify outside lock.
    internal func setNativeValueUnderLock(contractId: String, scope: Scope, stateKey: String, value: Any?) {
        let key = StoreKey(contractId: contractId, stateKey: stateKey, scopeKey: scope.serialized())
        states[key] = .available(value)
    }

    /// Snapshot observer callbacks. Called under lock; returned closures called OUTSIDE.
    internal func snapshotObserversInternal(contractId: String, stateKey: String, scope: Scope) -> [([String: Any?]) -> Void] {
        return snapshotObservers(contractId: contractId, stateKey: stateKey, scope: scope)
    }

    // MARK: - JS-provided writes

    /// Write a state value from the JS side.
    /// Returns `{ ok: true }` or `{ ok: false, code: "NOT_PROVIDER" }`.
    @discardableResult
    internal func writeFromJs(
        contractId: String,
        scope: Scope,
        stateKey: String,
        value: Any?,
        nativeOwnsBinding: Bool
    ) -> [String: Any?] {
        if nativeOwnsBinding {
            return [
                "ok": false,
                "code": "NOT_PROVIDER",
                "message": "Native side owns binding for '\(contractId)'; JS cannot write state",
                "contractId": contractId
            ]
        }
        let key = StoreKey(contractId: contractId, stateKey: stateKey, scopeKey: scope.serialized())
        let keyStr = keyString(key)
        graceJobs.removeValue(forKey: keyStr)?.cancel()
        states[key] = .available(value)
        let snapshot = snapshotObservers(contractId: contractId, stateKey: stateKey, scope: scope)
        notifyObservers(snapshot: snapshot, env: ["v": value])
        return ["ok": true, "value": ["v": value]]
    }

    // MARK: - Reads

    internal func read(contractId: String, scope: Scope, stateKey: String, initial: Any?) -> BridgeValue<Any?> {
        let key = StoreKey(contractId: contractId, stateKey: stateKey, scopeKey: scope.serialized())
        return states[key] ?? .initial(initial)
    }

    // MARK: - Observers

    internal func observe(
        contractId: String,
        scope: Scope,
        stateKey: String,
        epoch: Int64,
        onChange: @escaping ([String: Any?]) -> Void
    ) -> String {
        obsCounter += 1
        let obsId = "obs_\(obsCounter)"
        observers[obsId] = Observer(
            contractId: contractId,
            stateKey: stateKey,
            scopeKey: scope.serialized(),
            onChange: onChange,
            epoch: epoch
        )
        return obsId
    }

    internal func unobserve(_ obsId: String) {
        observers.removeValue(forKey: obsId)
    }

    /// Remove all observers registered for a given epoch (called on epoch swap).
    internal func clearObserversForEpoch(_ epoch: Int64) {
        observers = observers.filter { $0.value.epoch != epoch }
    }

    // MARK: - Unprovide paths

    /// Transition all state entries for a contract+scope to Unprovided.
    ///
    /// Called from Router.removeBinding (engine lock held).
    /// Returns snapshots for caller to notify OUTSIDE lock.
    @discardableResult
    internal func markUnprovided(contractId: String, scope: Scope) -> [ObserverSnapshot] {
        let scopeKey = scope.serialized()
        var goneSnapshots: [ObserverSnapshot] = []
        for (key, value) in states {
            guard key.contractId == contractId && key.scopeKey == scopeKey else { continue }
            let lastKnown = value.valueOrNil()
            states[key] = .unprovided(lastKnown)
            goneSnapshots.append(snapshotObservers(contractId: key.contractId, stateKey: key.stateKey, scope: scope))
        }
        return goneSnapshots
    }

    /// Notify gone snapshots outside the lock (call after markUnprovided).
    internal func notifyGoneSnapshots(_ snapshots: [ObserverSnapshot]) {
        for snapshot in snapshots { notifyObserversGone(snapshot: snapshot) }
    }

    /// Mark all JS-provided contract states as Replacing, then transition to Unprovided
    /// after replacingGraceMs if no re-provision arrives.
    ///
    /// Called from Router.connectDispatcher (engine lock held).
    /// Returns immediate snapshots for caller to fire OUTSIDE lock.
    /// Grace Task notifications fire outside the lock by design.
    @discardableResult
    internal func markJsContractsUnprovided(_ jsContractIds: Set<String>) -> [ObserverSnapshot] {
        var toSchedule: [(StoreKey, Any?)] = []
        var immediateSnapshots: [ObserverSnapshot] = []

        for (key, value) in states {
            guard jsContractIds.contains(key.contractId) else { continue }
            let lastKnown = value.valueOrNil()
            states[key] = .replacing(lastKnown)
            let scope = Scope.deserialize(key.scopeKey)
            immediateSnapshots.append(snapshotObservers(contractId: key.contractId, stateKey: key.stateKey, scope: scope))
            let keyStr = keyString(key)
            graceJobs.removeValue(forKey: keyStr)?.cancel()
            toSchedule.append((key, lastKnown))
        }

        let graceNanos = replacingGraceMs * 1_000_000
        for (key, lastKnown) in toSchedule {
            let keyStr = keyString(key)
            let task = Task<Void, Never> {
                try? await Task.sleep(nanoseconds: graceNanos)
                // Only transition if still Replacing (a re-provision may have already arrived).
                self.lock.lock()
                guard case .replacing = self.states[key] else {
                    self.graceJobs.removeValue(forKey: keyStr)
                    self.lock.unlock()
                    return
                }
                self.states[key] = .unprovided(lastKnown)
                self.graceJobs.removeValue(forKey: keyStr)
                let scope = Scope.deserialize(key.scopeKey)
                let snapshot = self.snapshotObservers(contractId: key.contractId, stateKey: key.stateKey, scope: scope)
                self.lock.unlock()
                self.notifyObserversGone(snapshot: snapshot)
            }
            graceJobs[keyStr] = task
        }

        return immediateSnapshots
    }

    // MARK: - Notification helpers (called outside engine lock)

    internal typealias ObserverSnapshot = [([String: Any?]) -> Void]

    private func snapshotObservers(contractId: String, stateKey: String, scope: Scope) -> ObserverSnapshot {
        let scopeKey = scope.serialized()
        return observers.values
            .filter { $0.contractId == contractId && $0.stateKey == stateKey && $0.scopeKey == scopeKey }
            .map { $0.onChange }
    }

    private func notifyObservers(snapshot: ObserverSnapshot, env: [String: Any?]) {
        for cb in snapshot { cb(env) }
    }

    /// Sends {"status":"gone"} without "v" — JS sees undefined → stale/unprovided branch.
    private func notifyObserversGone(snapshot: ObserverSnapshot) {
        let goneEnv: [String: Any?] = ["status": "gone"]
        for cb in snapshot { cb(goneEnv) }
    }

    // MARK: - State stream (for OutboundCallerImpl.state())

    /// Returns an AsyncStream that delivers the current value immediately, then
    /// subsequent values via observer notification.
    internal func stateStream(
        contractId: String,
        scope: Scope,
        stateKey: String,
        initial: Any?
    ) -> AsyncStream<BridgeValue<Any?>> {
        let storeKey = StoreKey(contractId: contractId, stateKey: stateKey, scopeKey: scope.serialized())

        return AsyncStream<BridgeValue<Any?>> { continuation in
            self.lock.lock()
            let current = self.states[storeKey] ?? .initial(initial)
            continuation.yield(current)

            self.obsCounter += 1
            let obsId = "obs_stream_\(self.obsCounter)"
            self.observers[obsId] = Observer(
                contractId: contractId,
                stateKey: stateKey,
                scopeKey: scope.serialized(),
                onChange: { env in
                    if let v = env["v"] {
                        continuation.yield(.available(v))
                        return
                    }
                    // A notification without "v" means the provider went away or is
                    // being swapped. Read the authoritative entry rather than
                    // synthesising one: the store already tracks
                    // `.replacing(lastKnown)` and `.unprovided(lastKnown)`, and
                    // collapsing both to `.unprovided(nil)` here discarded
                    // lastKnown on every swap and made `.replacing` unobservable —
                    // while Android surfaces the live StateFlow holding
                    // Replacing(lastKnown). The lock is recursive and notifications
                    // are dispatched outside it, so this is safe on both paths.
                    self.lock.lock()
                    let authoritative = self.states[storeKey] ?? .unprovided(nil)
                    self.lock.unlock()
                    continuation.yield(authoritative)
                },
                epoch: Int64.max  // never pruned by clearObserversForEpoch
            )
            self.lock.unlock()

            continuation.onTermination = { _ in
                self.lock.lock()
                self.observers.removeValue(forKey: obsId)
                self.lock.unlock()
            }
        }
    }

    // MARK: - Dump

    internal func dump() -> String {
        let lines = states.sorted(by: { $0.key.contractId < $1.key.contractId }).map { key, value in
            "state|\(key.contractId)|\(key.stateKey)|\(key.scopeKey)|\(value)"
        }
        return lines.joined(separator: "\n") + "\nobservers=\(observers.count)"
    }

    // MARK: - Helpers

    private func keyString(_ key: StoreKey) -> String {
        "\(key.contractId)|\(key.stateKey)|\(key.scopeKey)"
    }
}
