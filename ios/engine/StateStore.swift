// StateStore.swift
// BridgeKit iOS engine — bidirectional state store.
//
// Port of io/github/malopezr7/bridgekit/core/StateStore.kt
//
// DESIGN (Decision 3): lock-guarded current BridgeValue + per-observer callback list.
// NOT an actor (blocks sync read). NOT Combine (dep). 4-case BridgeValue enum UNCHANGED.
//
// INV-6 (H-13): notifyObserversGone sends {"status":"gone"} WITHOUT "v" key.
//   JS sees map.v === undefined → stale/unprovided branch.
//   ADDITIVE: no new BridgeValue case.
//
// INV-8 (grace window): Replacing → Unprovided after replacingGraceMs (250ms).
//   grace Task cancelled on re-provision OR seedNativeState.
//
// PORT NOTE: Kotlin used MutableStateFlow per key (StateFlow.value is thread-safe).
// Swift: plain BridgeValue<Any?> stored under the engine NSRecursiveLock.
// Observers are [String: Observer] (obsId → struct) also under the same lock.

import Foundation

internal final class StateStore {

    /// Duration in ms that state entries remain in Replacing state before → Unprovided.
    /// INV-8 (grace window).
    internal let replacingGraceMs: UInt64  // nanoseconds internally; ms at API surface

    private struct StoreKey: Hashable {
        let contractId: String
        let stateKey: String
        let scopeKey: String
    }

    // All state guarded by the engine NSRecursiveLock (shared with Router).
    // PORT NOTE: Kotlin used ConcurrentHashMap<StoreKey, MutableStateFlow<BridgeValue>>.
    // Swift: plain Dictionary guarded by the engine lock.
    private var states: [StoreKey: BridgeValue<Any?>] = [:]

    // INV-8: grace-window Task handles (Task<Void,Never>).
    // Cancelled on re-provision or seedNativeState.
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

    // -------------------------------------------------------------------------
    // Native-provided seeding
    // -------------------------------------------------------------------------

    /// Seed the store with an initial value for a native-provided contract.
    /// Also cancels any active grace job for this key.
    ///
    /// INV-8: cancel grace Task on seedNativeState.
    internal func seedNativeState(contractId: String, scope: Scope, stateKey: String, initial: Any?) {
        let key = StoreKey(contractId: contractId, stateKey: stateKey, scopeKey: scope.serialized())
        let keyStr = keyString(key)
        // INV-8: cancel grace before overwriting with Available.
        graceJobs.removeValue(forKey: keyStr)?.cancel()
        states[key] = .available(initial)
    }

    /// Update a native state entry (provider emitted a new value).
    /// Writes state under lock AND notifies observers outside lock.
    /// Caller (stateWrite/writeFromJs paths) holds the lock; use the split methods below.
    internal func setNativeValue(contractId: String, scope: Scope, stateKey: String, value: Any?) {
        let key = StoreKey(contractId: contractId, stateKey: stateKey, scopeKey: scope.serialized())
        states[key] = .available(value)
        let snapshot = snapshotObservers(contractId: contractId, stateKey: stateKey, scope: scope)
        // Notifications called inline here only for paths that DON'T hold the engine lock.
        // For paths that DO hold the lock, use setNativeValueUnderLock + snapshotObserversInternal.
        notifyObservers(snapshot: snapshot, env: ["v": value])
    }

    /// Write native state under the engine lock (lock already held by caller).
    /// Does NOT notify observers — caller must snapshot and notify outside lock.
    internal func setNativeValueUnderLock(contractId: String, scope: Scope, stateKey: String, value: Any?) {
        let key = StoreKey(contractId: contractId, stateKey: stateKey, scopeKey: scope.serialized())
        states[key] = .available(value)
    }

    /// Snapshot the observer callbacks for a given (contractId, stateKey, scope).
    /// Called under the engine lock; returned closures are called OUTSIDE the lock.
    internal func snapshotObserversInternal(contractId: String, stateKey: String, scope: Scope) -> [([String: Any?]) -> Void] {
        return snapshotObservers(contractId: contractId, stateKey: stateKey, scope: scope)
    }

    // -------------------------------------------------------------------------
    // JS-provided writes
    // -------------------------------------------------------------------------

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
        // INV-8: cancel grace on JS re-provision.
        graceJobs.removeValue(forKey: keyStr)?.cancel()
        states[key] = .available(value)
        let snapshot = snapshotObservers(contractId: contractId, stateKey: stateKey, scope: scope)
        notifyObservers(snapshot: snapshot, env: ["v": value])
        return ["ok": true, "value": ["v": value]]
    }

    // -------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------

    internal func read(contractId: String, scope: Scope, stateKey: String, initial: Any?) -> BridgeValue<Any?> {
        let key = StoreKey(contractId: contractId, stateKey: stateKey, scopeKey: scope.serialized())
        return states[key] ?? .initial(initial)
    }

    // -------------------------------------------------------------------------
    // Observers
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // Unprovide paths
    // -------------------------------------------------------------------------

    /// Transition all state entries for a contract+scope to Unprovided.
    /// INV-6 (H-13): notifyObserversGone after state transition.
    ///
    /// Called from Router.removeBinding which holds the engine lock.
    /// Returns snapshots for caller to notify OUTSIDE lock.
    @discardableResult
    internal func markUnprovided(contractId: String, scope: Scope) -> [ObserverSnapshot] {
        let scopeKey = scope.serialized()
        var goneSnapshots: [ObserverSnapshot] = []
        for (key, value) in states {
            guard key.contractId == contractId && key.scopeKey == scopeKey else { continue }
            let lastKnown = value.valueOrNil()
            states[key] = .unprovided(lastKnown)
            // INV-6 (H-13): snapshot under lock; caller notifies outside lock.
            goneSnapshots.append(snapshotObservers(contractId: key.contractId, stateKey: key.stateKey, scope: scope))
        }
        return goneSnapshots
    }

    /// Notify gone snapshots outside the lock (call after markUnprovided).
    internal func notifyGoneSnapshots(_ snapshots: [ObserverSnapshot]) {
        for snapshot in snapshots { notifyObserversGone(snapshot: snapshot) }
    }

    /// Mark ALL JS-provided contract states as Replacing (grace window), then
    /// transition to Unprovided after replacingGraceMs if no re-provision arrives.
    ///
    /// INV-8 (grace window): Replacing → Unprovided after 250ms.
    /// INV-6 (H-13): notifyObserversGone on Replacing transition AND on grace-expiry.
    ///
    /// Called from Router.connectDispatcher which holds the engine lock.
    /// Returns immediate-notification snapshots for caller to fire OUTSIDE lock.
    /// Grace Task notifications happen inside the Task body (outside lock by design).
    ///
    /// PORT NOTE: Kotlin used `graceScope.launch { delay(replacingGraceMs) }`.
    /// Swift: `Task { try? await Task.sleep(nanoseconds: ms * 1_000_000) }`.
    @discardableResult
    internal func markJsContractsUnprovided(_ jsContractIds: Set<String>) -> [ObserverSnapshot] {
        var toSchedule: [(StoreKey, Any?)] = []
        var immediateSnapshots: [ObserverSnapshot] = []

        for (key, value) in states {
            guard jsContractIds.contains(key.contractId) else { continue }
            let lastKnown = value.valueOrNil()
            states[key] = .replacing(lastKnown)
            // INV-6 (H-13): snapshot for immediate Replacing notification.
            let scope = Scope.deserialize(key.scopeKey)
            immediateSnapshots.append(snapshotObservers(contractId: key.contractId, stateKey: key.stateKey, scope: scope))
            // Cancel prior grace job.
            let keyStr = keyString(key)
            graceJobs.removeValue(forKey: keyStr)?.cancel()
            toSchedule.append((key, lastKnown))
        }

        // Schedule grace Tasks (Task.init is non-blocking; safe to call under lock).
        let graceNanos = replacingGraceMs * 1_000_000
        for (key, lastKnown) in toSchedule {
            let keyStr = keyString(key)
            let task = Task<Void, Never> {
                try? await Task.sleep(nanoseconds: graceNanos)
                // Re-acquire engine lock to check if still Replacing.
                self.lock.lock()
                // INV-8: only transition if still Replacing.
                guard case .replacing = self.states[key] else {
                    self.graceJobs.removeValue(forKey: keyStr)
                    self.lock.unlock()
                    return
                }
                self.states[key] = .unprovided(lastKnown)
                self.graceJobs.removeValue(forKey: keyStr)
                // INV-6 (H-13): snapshot for grace-expiry → Unprovided notification.
                let scope = Scope.deserialize(key.scopeKey)
                let snapshot = self.snapshotObservers(contractId: key.contractId, stateKey: key.stateKey, scope: scope)
                self.lock.unlock()
                // Notify OUTSIDE lock.
                self.notifyObserversGone(snapshot: snapshot)
            }
            graceJobs[keyStr] = task
        }

        // Return immediate snapshots for caller to fire outside its lock.
        return immediateSnapshots
    }

    // -------------------------------------------------------------------------
    // Notification helpers (called outside engine lock)
    // -------------------------------------------------------------------------

    internal typealias ObserverSnapshot = [([String: Any?]) -> Void]

    private func snapshotObservers(contractId: String, stateKey: String, scope: Scope) -> ObserverSnapshot {
        let scopeKey = scope.serialized()
        return observers.values
            .filter { $0.contractId == contractId && $0.stateKey == stateKey && $0.scopeKey == scopeKey }
            .map { $0.onChange }
    }

    private func notifyObservers(snapshot: ObserverSnapshot, env: [String: Any?]) {
        // Swallow per-observer errors (matches Kotlin catch(_: Exception) {}).
        // The closures are non-throwing; just call them directly.
        for cb in snapshot { cb(env) }
    }

    /// INV-6 (H-13): send {"status":"gone"} WITHOUT "v" key.
    private func notifyObserversGone(snapshot: ObserverSnapshot) {
        // PORT NOTE: Kotlin `mapOf("status" to "gone")` — no "v" key.
        // JS StateMirror._attachObserver: `onChange(map.v)` → undefined → stale branch.
        let goneEnv: [String: Any?] = ["status": "gone"]
        for cb in snapshot { cb(goneEnv) }
    }

    // -------------------------------------------------------------------------
    // State stream (for OutboundCallerImpl.state())
    // -------------------------------------------------------------------------

    /// Return an AsyncStream<BridgeValue<Any?>> that delivers the current value
    /// immediately and then on each subsequent change via observer notification.
    ///
    /// PORT NOTE: Kotlin returned StateFlow<BridgeValue<Any?>> which replays the
    /// current value to each new collector. Swift equivalent: AsyncStream with
    /// a continuation registered in the observer map. The stream delivers the
    /// current value immediately, then observers push subsequent changes.
    internal func stateStream(
        contractId: String,
        scope: Scope,
        stateKey: String,
        initial: Any?
    ) -> AsyncStream<BridgeValue<Any?>> {
        return AsyncStream<BridgeValue<Any?>> { continuation in
            self.lock.lock()
            // Deliver current value immediately.
            let current = self.states[StoreKey(contractId: contractId, stateKey: stateKey, scopeKey: scope.serialized())] ?? .initial(initial)
            continuation.yield(current)

            // Register observer for changes.
            self.obsCounter += 1
            let obsId = "obs_stream_\(self.obsCounter)"
            self.observers[obsId] = Observer(
                contractId: contractId,
                stateKey: stateKey,
                scopeKey: scope.serialized(),
                onChange: { env in
                    // env is either {"v": value} or {"status": "gone"}.
                    if let v = env["v"] {
                        continuation.yield(.available(v))
                    } else {
                        // Gone signal: deliver Unprovided.
                        continuation.yield(.unprovided(nil))
                    }
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

    // -------------------------------------------------------------------------
    // Dump
    // -------------------------------------------------------------------------

    internal func dump() -> String {
        let lines = states.sorted(by: { $0.key.contractId < $1.key.contractId }).map { key, value in
            "state|\(key.contractId)|\(key.stateKey)|\(key.scopeKey)|\(value)"
        }
        return lines.joined(separator: "\n") + "\nobservers=\(observers.count)"
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private func keyString(_ key: StoreKey) -> String {
        "\(key.contractId)|\(key.stateKey)|\(key.scopeKey)"
    }
}
