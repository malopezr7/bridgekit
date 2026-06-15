// Router.swift
// BridgeKit iOS engine — routing engine implementing BridgeKitNativeDelegate.
//
// Port of io/github/malopezr7/bridgekit/core/Router.kt
//
// CONCURRENCY MODEL (Design Decision 1 — HYBRID):
//   ONE shared NSRecursiveLock (engineLock) runs ALL sync-returning paths
//   synchronously — 1:1 with Kotlin `synchronized(lock)`.
//   Tasks (async) ONLY for: invoke, stream pumps, OutboundCaller calls, grace timer.
//   Do NOT make Router an actor (deadlocks the sync specs on the JS thread).
//
// ALL 12 INVARIANTS implemented; each site annotated // INV-N.

import Foundation

// ---- JsDispatcherCallbacks -------------------------------------------------

/// Callbacks that the dispatcher passes back to JS.
///
/// Port: `class JsDispatcherCallbacks` (Kotlin).
public final class JsDispatcherCallbacks {
    public let onInvoke: (
        _ env: [String: Any?],
        _ completion: @escaping (_ ok: [String: Any?]?, _ err: Error?) -> Void
    ) -> Void

    public let onStreamOpen:  (_ env: [String: Any?]) -> Void
    public let onStreamClose: (_ env: [String: Any?]) -> Void
    public let onStateWrite:  (_ env: [String: Any?]) -> Void

    public init(
        onInvoke: @escaping (
            _ env: [String: Any?],
            _ completion: @escaping (_ ok: [String: Any?]?, _ err: Error?) -> Void
        ) -> Void,
        onStreamOpen:  @escaping (_ env: [String: Any?]) -> Void,
        onStreamClose: @escaping (_ env: [String: Any?]) -> Void,
        onStateWrite:  @escaping (_ env: [String: Any?]) -> Void
    ) {
        self.onInvoke     = onInvoke
        self.onStreamOpen  = onStreamOpen
        self.onStreamClose = onStreamClose
        self.onStateWrite  = onStateWrite
    }
}

// ---- JS stream channel types -----------------------------------------------

/// Bidirectional async pipe for one JS→native stream.
typealias JsStreamChannel = (
    stream: AsyncStream<[String: Any?]>,
    continuation: AsyncStream<[String: Any?]>.Continuation
)

// ---- Router ----------------------------------------------------------------

internal final class Router {

    // ---- Engine lock -----------------------------------------------------------

    /// Shared NSRecursiveLock — all sync paths run fully inside this lock.
    /// PORT NOTE: Kotlin `synchronized(lock)` → Swift `lock.lock() / lock.unlock()`.
    /// Never hold this lock across an `await` (would deadlock on re-entry from Nitro).
    internal let lock = NSRecursiveLock()

    // ---- Configuration ---------------------------------------------------------

    internal let readinessTimeoutMs: UInt64
    internal let callTimeoutMs: UInt64
    internal let strictHashCheck: Bool

    // ---- Binding registry ------------------------------------------------------

    // (contractId, scopeKey) → BindingEntry
    // Guarded by lock.
    private var bindings: [String: BindingEntry] = [:]

    private func bindingKey(contractId: String, scope: Scope) -> String {
        "\(contractId)|\(scope.serialized())"
    }

    // ---- Epoch -----------------------------------------------------------------

    // PORT NOTE: Kotlin `AtomicLong` → Swift Int64 guarded by engineLock.
    // epochCounter is only incremented inside connectDispatcher (under lock).
    private var epochCounter: Int64 = 0
    internal func currentEpoch() -> Int64 {
        lock.lock(); defer { lock.unlock() }
        return epochCounter
    }

    // ---- JS dispatcher ---------------------------------------------------------

    // PORT NOTE: Kotlin `@Volatile var jsCallbacks`. Swift: plain optional guarded by
    // engineLock (all reads under lock; write in connectDispatcher under lock).
    private var jsCallbacks: JsDispatcherCallbacks? = nil

    internal func getJsCallbacks() -> JsDispatcherCallbacks? {
        lock.lock(); defer { lock.unlock() }
        return jsCallbacks
    }

    // ---- JS-consume stream tracking (native consumes JS-provided streams) ------

    // PORT NOTE: Kotlin `ConcurrentHashMap<String, Channel<...>>`.
    // Swift: Dictionary guarded by engineLock.
    // Value is (AsyncStream, its continuation) so emitFromJs can push values.
    internal var jsStreamChannels: [String: JsStreamChannel] = [:]
    internal var jsStreamEndContinuations: [String: AsyncStream<[String: Any?]>.Continuation] = [:]

    // ---- Native→JS stream pump tracking ----------------------------------------

    // streamId → (epoch, task)
    private var streamPumpJobs: [String: (Int64, Task<Void, Never>)] = [:]

    // ---- StreamHub (W3-3 multiplexing) -----------------------------------------

    private var streamHub: StreamHub

    // ---- JS-provided contract set ----------------------------------------------

    // Guarded by lock.
    private var jsProvidedContracts: Set<String> = []

    // ---- StateStore (internal access) ------------------------------------------

    internal let stateStore: StateStore

    // ---- ParkBuffer ------------------------------------------------------------

    private let parkBuffer: ParkBuffer

    // -------------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------------

    internal init(
        readinessTimeoutMs: UInt64 = 5_000,
        callTimeoutMs: UInt64 = 30_000,
        strictHashCheck: Bool = false
    ) {
        self.readinessTimeoutMs = readinessTimeoutMs
        self.callTimeoutMs = callTimeoutMs
        self.strictHashCheck = strictHashCheck
        self.stateStore = StateStore(lock: lock)
        self.parkBuffer = ParkBuffer()
        self.streamHub = StreamHub(lock: lock)
    }

    // =========================================================================
    // BridgeKitNativeDelegate surface
    // (All methods below are the 1:1 port of Router.kt's BridgeKitNativeDelegate impl)
    // =========================================================================

    // ---- invoke (async) -------------------------------------------------------

    /// Async invoke. Calls `complete` exactly once.
    ///
    /// INV-1 (epoch guard): reject stale ops BEFORE side-effects.
    /// epochEnv == 0 = pre-connection sentinel; do NOT reject.
    func invoke(env: [String: Any?], complete: @escaping ([String: Any?]) -> Void) {
        guard let contractId = env["contractId"] as? String else {
            return complete(Self.errEnv("CONTRACT_NOT_PROVIDED", "Missing contractId"))
        }
        guard let member = env["member"] as? String else {
            return complete(Self.errEnv("METHOD_NOT_FOUND", "Missing member"))
        }
        let scope = parseScopeEnv(env)
        let epochEnv = (env["epoch"] as? NSNumber)?.int64Value ?? 0
        let payload = extractPayload(env)

        let currentEpoch: Int64
        lock.lock()
        currentEpoch = epochCounter
        lock.unlock()

        Task {
            // INV-1: epoch guard.
            if epochEnv != 0 && epochEnv < currentEpoch {
                complete(Self.errEnv(
                    "BRIDGE_NOT_READY",
                    "Stale epoch: request epoch=\(epochEnv) current=\(currentEpoch)",
                    contractId, member, scope
                ))
                return
            }
            let result = await self.invokeWithReadiness(
                contractId: contractId, scope: scope, member: member,
                payload: payload, epochEnv: epochEnv, currentEpoch: currentEpoch, env: env
            )
            complete(result)
        }
    }

    // ---- invokeSync -----------------------------------------------------------

    /// Synchronous invoke. Runs synchronously inside the engine lock.
    func invokeSync(env: [String: Any?]) -> [String: Any?] {
        lock.lock()
        defer { lock.unlock() }

        guard let contractId = env["contractId"] as? String else {
            return Self.errEnv("CONTRACT_NOT_PROVIDED", "Missing contractId")
        }
        guard let member = env["member"] as? String else {
            return Self.errEnv("METHOD_NOT_FOUND", "Missing member")
        }
        let scope = parseScopeEnv(env)
        let payload = extractPayload(env)

        guard let binding = resolveBinding(contractId: contractId, scope: scope) else {
            return Self.errEnv(
                "CONTRACT_NOT_PROVIDED",
                "Contract '\(contractId)' not provided in scope \(scope.serialized())",
                contractId, member, scope
            )
        }

        if let hashErr = checkContractHash(contractId: contractId, member: member, scope: scope, binding: binding, env: env) {
            return hashErr
        }

        do {
            // invokeSync is sync; adapter must not block.
            // PORT NOTE: Swift does not have `runBlocking`; we call synchronously.
            // The adapter's invokeSync is a plain throws func (not async).
            let result = try binding.adapter.invokeSync(member: member, payload: payload)
            return Self.okEnv(result)
        } catch let e as BridgeKitDecodeError {
            // INV-10: BridgeKitDecodeError → VALIDATION_FAILED.
            return Self.errEnv("VALIDATION_FAILED", "Decode failed for '\(member)' on '\(contractId)': \(e.description)", contractId, member, scope)
        } catch let e as BridgeKitError where e.code == "METHOD_NOT_FOUND" {
            return Self.errEnv("METHOD_NOT_FOUND", "No sync method '\(member)' in contract '\(contractId)': \(e.message)", contractId, member, scope)
        } catch {
            return Self.errEnv("PROVIDER_ERROR", "Sync call failed: \(error.localizedDescription)", contractId, member, scope)
        }
    }

    // ---- connectDispatcher ----------------------------------------------------

    /// Register the JS dispatcher for a new runtime epoch.
    /// Returns { epoch: Number, snapshot: [...] }.
    ///
    /// INV-1 (epoch guard on subsequent calls): epoch increment done here.
    /// INV-2 (H-8): closes + clears jsStreamChannels/jsStreamEndContinuations ATOMIC
    ///               with epoch increment.
    func connectDispatcher(
        epochInfo: [String: Any?],
        callbacks: JsDispatcherCallbacks
    ) -> [String: Any?] {
        lock.lock()

        // Increment epoch atomically with stream channel teardown — INV-2 (H-8).
        epochCounter += 1
        let newEpoch = epochCounter

        // Cancel prior-epoch stream pump tasks.
        // Collect stale IDs first, then cancel (avoid mutating while iterating).
        let staleStreamIds = streamPumpJobs.compactMap { sid, pair -> String? in
            pair.0 < newEpoch ? sid : nil
        }
        for sid in staleStreamIds {
            streamPumpJobs.removeValue(forKey: sid)?.1.cancel()
        }

        // Cancel and recreate StreamHub.
        streamHub.cancelAll()
        streamHub = StreamHub(lock: lock)

        // INV-2 (H-8): close all JS→native stream channels + end signals with BRIDGE_NOT_READY.
        // This is ATOMIC with the epoch increment (both inside lock).
        for (_, channel) in jsStreamChannels {
            channel.continuation.finish()
        }
        jsStreamChannels.removeAll()
        for (_, endCont) in jsStreamEndContinuations {
            // INV-2 (H-8): Deliver BRIDGE_NOT_READY end signal then finish.
            endCont.yield(["ok": false, "code": "BRIDGE_NOT_READY", "message": "Epoch swap: prior stream invalidated"])
            endCont.finish()
        }
        jsStreamEndContinuations.removeAll()

        // Fail in-flight native→JS calls (park buffer).
        parkBuffer.failAllPending()

        // Mark all JS-provided contracts unprovided + clear state.
        // Returns immediate-notification snapshots to fire OUTSIDE the lock.
        let goneSnapshots = stateStore.markJsContractsUnprovided(jsProvidedContracts)

        // Remove stale observers for previous epoch.
        stateStore.clearObserversForEpoch(newEpoch - 1)

        // Install new dispatcher.
        jsCallbacks = callbacks

        lock.unlock()

        // INV-6 (H-13): notify observers OUTSIDE lock.
        stateStore.notifyGoneSnapshots(goneSnapshots)

        // Build state snapshot of native-provided entries (outside lock — reads are safe).
        let snapshot = buildNativeStateSnapshot()

        return [
            "epoch": newEpoch,
            "snapshot": snapshot
        ]
    }

    // ---- openStream -----------------------------------------------------------

    /// Open a native→JS stream. Returns the stream id.
    ///
    /// INV-1 (epoch guard): reject stale openStream BEFORE side-effects.
    /// INV-5 (H-7): recheck isLive after streamJobs insert.
    func openStream(
        env: [String: Any?],
        onNext: @escaping ([String: Any?]) -> Void,
        onEnd: @escaping ([String: Any?]) -> Void
    ) -> String {
        guard let contractId = env["contractId"] as? String else {
            onEnd(Self.errEnv("CONTRACT_NOT_PROVIDED", "Missing contractId"))
            return ""
        }
        guard let member = env["member"] as? String else {
            onEnd(Self.errEnv("METHOD_NOT_FOUND", "Missing member"))
            return ""
        }
        let scope = parseScopeEnv(env)
        let payload = extractPayload(env)

        lock.lock()
        let currentEpochAtOpen = epochCounter
        let streamEpoch = (env["epoch"] as? NSNumber)?.int64Value ?? currentEpochAtOpen

        // INV-1: epoch guard.
        if streamEpoch != 0 && streamEpoch < currentEpochAtOpen {
            lock.unlock()
            onEnd(Self.errEnv(
                "BRIDGE_NOT_READY",
                "Stale epoch: request epoch=\(streamEpoch) current=\(currentEpochAtOpen)",
                contractId, member, scope
            ))
            return ""
        }

        guard let binding = resolveBinding(contractId: contractId, scope: scope) else {
            lock.unlock()
            onEnd(Self.errEnv("CONTRACT_NOT_PROVIDED", "Contract '\(contractId)' not provided", contractId, member, scope))
            return ""
        }

        if let hashErr = checkContractHash(contractId: contractId, member: member, scope: scope, binding: binding, env: env) {
            lock.unlock()
            onEnd(hashErr)
            return ""
        }

        // INV-9: paramsHash for StreamHub keying.
        let pHash = paramsHash(payload)
        let streamId = "\(contractId)_\(member)_\(pHash)_\(mach_absolute_time())"

        // Capture adapter for the closure (lock held during attach).
        let adapter = binding.adapter

        let consumerTask = streamHub.attach(
            contractId: contractId,
            member: member,
            scope: scope,
            paramsHash: pHash,
            openStream: { adapter.openStream(member: member, payload: payload) },
            onNext: onNext,
            onEnd: { [weak self] endEnv in
                self?.lock.lock()
                self?.streamPumpJobs.removeValue(forKey: streamId)
                self?.lock.unlock()
                onEnd(endEnv)
            }
        )

        streamPumpJobs[streamId] = (streamEpoch, consumerTask)

        // INV-5 (H-7): register job in binding, then recheck isLive.
        binding.registerStreamJob(streamId, job: consumerTask)
        // H-7: if binding died between openStream's check and here, the job was already
        // cancelled in registerStreamJob. Nothing more to do — onEnd will fire via cancel.

        lock.unlock()
        return streamId
    }

    // ---- closeStream ----------------------------------------------------------

    func closeStream(streamId: String) {
        lock.lock()
        let entry = streamPumpJobs.removeValue(forKey: streamId)
        lock.unlock()
        entry?.1.cancel()
    }

    // ---- emitFromJs -----------------------------------------------------------

    func emitFromJs(streamId: String, value: [String: Any?]) {
        lock.lock()
        let channel = jsStreamChannels[streamId]
        lock.unlock()
        // PORT NOTE: Kotlin `channel.trySend(value)` — AsyncStream yields non-blocking.
        // If the consumer has cancelled, the continuation is finished; yield is a no-op.
        channel?.continuation.yield(value)
    }

    // ---- endFromJs ------------------------------------------------------------

    func endFromJs(streamId: String, end: [String: Any?]) {
        lock.lock()
        let endCont = jsStreamEndContinuations[streamId]
        lock.unlock()
        endCont?.yield(end)
        endCont?.finish()
    }

    // ---- stateRead ------------------------------------------------------------

    func stateRead(env: [String: Any?]) -> [String: Any?] {
        lock.lock()
        defer { lock.unlock() }
        guard let contractId = env["contractId"] as? String else {
            return Self.errEnv("CONTRACT_NOT_PROVIDED", "Missing contractId")
        }
        guard let stateKey = env["member"] as? String else {
            return Self.errEnv("VALIDATION_FAILED", "Missing member/stateKey")
        }
        let scope = parseScopeEnv(env)
        let value = stateStore.read(contractId: contractId, scope: scope, stateKey: stateKey, initial: nil)
        return Self.okEnv(["v": value.valueOrNil()])
    }

    // ---- stateObserve ---------------------------------------------------------

    func stateObserve(env: [String: Any?], onChange: @escaping ([String: Any?]) -> Void) -> String {
        lock.lock()
        defer { lock.unlock() }
        guard let contractId = env["contractId"] as? String else { return "" }
        guard let stateKey = env["member"] as? String else { return "" }
        let scope = parseScopeEnv(env)
        return stateStore.observe(
            contractId: contractId, scope: scope, stateKey: stateKey,
            epoch: epochCounter, onChange: onChange
        )
    }

    // ---- stateUnobserve -------------------------------------------------------

    func stateUnobserve(obsId: String) {
        lock.lock()
        defer { lock.unlock() }
        stateStore.unobserve(obsId)
    }

    // ---- stateWrite -----------------------------------------------------------

    /// Provider-side state write from JS.
    ///
    /// INV-1 (epoch guard): applied to stateWrite including provide/unprovide ops.
    func stateWrite(env: [String: Any?]) -> [String: Any?] {
        lock.lock()

        guard let contractId = env["contractId"] as? String else {
            lock.unlock()
            return Self.errEnv("CONTRACT_NOT_PROVIDED", "Missing contractId")
        }
        let scope = parseScopeEnv(env)
        let op = env["op"] as? String

        // INV-1: epoch guard — applies to stateWrite (including provide/unprovide).
        let epochEnv = (env["epoch"] as? NSNumber)?.int64Value ?? 0
        if epochEnv != 0 && epochEnv < epochCounter {
            lock.unlock()
            return Self.errEnv("BRIDGE_NOT_READY",
                "Stale epoch: request epoch=\(epochEnv) current=\(epochCounter)", contractId)
        }

        // ADR-5b: provide / unprovide ops branch BEFORE touching the state store.
        if op == "provide" {
            let nativeOwns = resolveBinding(contractId: contractId, scope: scope) != nil
            if !nativeOwns {
                markJsProvided(contractId)
                parkBuffer.unpark(contractId: contractId, scope: scope)
            }
            lock.unlock()
            return Self.okEnv(nil)
        }

        if op == "unprovide" {
            jsProvidedContracts.remove(contractId)
            let goneSnapshots = stateStore.markJsContractsUnprovided([contractId])
            lock.unlock()
            // INV-6 (H-13): notify outside lock.
            stateStore.notifyGoneSnapshots(goneSnapshots)
            return Self.okEnv(nil)
        }

        // Regular stateWrite path.
        guard let stateKey = env["member"] as? String else {
            lock.unlock()
            return Self.errEnv("VALIDATION_FAILED", "Missing member/stateKey")
        }
        let valueWrapped = env["payload"] as? [String: Any?]
        let value: Any? = valueWrapped?["v"] ?? Optional<Any>.none as Any?

        let nativeOwns = resolveBinding(contractId: contractId, scope: scope) != nil
        if !nativeOwns {
            markJsProvided(contractId)
            parkBuffer.unpark(contractId: contractId, scope: scope)
        }
        let result = stateStore.writeFromJs(
            contractId: contractId, scope: scope, stateKey: stateKey,
            value: value, nativeOwnsBinding: nativeOwns
        )
        lock.unlock()
        return result
    }

    // =========================================================================
    // Internal API (used by BridgeKit)
    // =========================================================================

    /// Register a native provider binding.
    /// If a binding already exists, it is closed with .replacing and replaced.
    internal func registerBinding(_ entry: BindingEntry) {
        lock.lock()
        let key = bindingKey(contractId: entry.contractId, scope: entry.scope)
        let previous = bindings[key]
        bindings[key] = entry

        if let prev = previous, prev.isLive {
            prev.close(reason: .replacing)
        }

        // Seed state store with initial values.
        for (stateKey, initial) in entry.adapter.stateInitials {
            stateStore.seedNativeState(contractId: entry.contractId, scope: entry.scope, stateKey: stateKey, initial: initial)
        }
        lock.unlock()

        // Subscribe to each provider state stream for change propagation.
        // PORT NOTE: Kotlin `entry.adapter.stateFlows().collect { ... }` inside engineScope.
        // Swift: Task per state stream; stored in binding so they cancel on binding.close().
        // LOCK DISCIPLINE: acquire lock to write state + snapshot observers, then release BEFORE
        // calling observer callbacks (avoids holding engine lock across JS Nitro callbacks).
        for (stateKey, stateStream) in entry.adapter.stateStreams() {
            let contractId = entry.contractId
            let scope = entry.scope
            let task = Task<Void, Never> {
                for await value in stateStream {
                    self.lock.lock()
                    // Write state under lock.
                    self.stateStore.setNativeValueUnderLock(contractId: contractId, scope: scope, stateKey: stateKey, value: value)
                    let snapshot = self.stateStore.snapshotObserversInternal(contractId: contractId, stateKey: stateKey, scope: scope)
                    self.lock.unlock()
                    // Notify OUTSIDE lock (avoids holding engine lock across JS/Nitro callbacks).
                    for cb in snapshot { cb(["v": value]) }
                }
            }
            lock.lock()
            entry.addStateObservation(task)
            lock.unlock()
        }

        lock.lock()
        parkBuffer.unpark(contractId: entry.contractId, scope: entry.scope)
        lock.unlock()
    }

    /// Resolve binding with instance→feature→global fallback.
    internal func resolveBinding(contractId: String, scope: Scope) -> BindingEntry? {
        // Called under lock (from sync paths) or under lock (from async paths that hold lock).
        if case .instance(let feature, _) = scope {
            if let b = bindings[bindingKey(contractId: contractId, scope: scope)] { return b }
            if let b = bindings[bindingKey(contractId: contractId, scope: .feature(feature))] { return b }
        } else if case .feature(_) = scope {
            if let b = bindings[bindingKey(contractId: contractId, scope: scope)] { return b }
        }
        return bindings[bindingKey(contractId: contractId, scope: .global)]
    }

    /// Remove a binding. Called by Binding.close().
    internal func removeBinding(_ entry: BindingEntry) {
        lock.lock()
        let key = bindingKey(contractId: entry.contractId, scope: entry.scope)
        if bindings[key] === entry { bindings.removeValue(forKey: key) }
        // INV-6 (H-13): markUnprovided returns snapshots; notify outside lock.
        let goneSnapshots = stateStore.markUnprovided(contractId: entry.contractId, scope: entry.scope)
        entry.cancelAllStreamJobs()
        lock.unlock()
        // Notify observers OUTSIDE engine lock.
        stateStore.notifyGoneSnapshots(goneSnapshots)
    }

    /// Await until (contractId, scope) is provided, with timeout.
    internal func awaitProvided(contractId: String, scope: Scope, timeoutMs: UInt64) async -> Bool {
        lock.lock()
        if resolveBinding(contractId: contractId, scope: scope) != nil { lock.unlock(); return true }
        if jsProvidedContracts.contains(contractId) { lock.unlock(); return true }

        return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            let once = OnceContinuationResult<Bool>(cont)
            let registered = self.parkBuffer.registerWaiter(
                contractId: contractId, scope: scope, cont: once
            )
            self.lock.unlock()

            if !registered {
                // Buffer full — fail immediately.
                once.resume(returning: false)
                return
            }

            // Timeout task.
            Task {
                try? await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
                once.resume(returning: false)
            }
        }
    }

    internal func isProvided(contractId: String, scope: Scope) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return resolveBinding(contractId: contractId, scope: scope) != nil
            || jsProvidedContracts.contains(contractId)
    }

    internal func markJsProvided(_ contractId: String) {
        // Called under lock.
        jsProvidedContracts.insert(contractId)
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    private func invokeWithReadiness(
        contractId: String,
        scope: Scope,
        member: String,
        payload: [String: Any?]?,
        epochEnv: Int64,
        currentEpoch: Int64,
        env: [String: Any?]
    ) async -> [String: Any?] {
        lock.lock()
        var binding = resolveBinding(contractId: contractId, scope: scope)
        lock.unlock()

        if binding == nil {
            let provided = await awaitProvided(contractId: contractId, scope: scope, timeoutMs: readinessTimeoutMs)
            if !provided {
                return Self.errEnv(
                    "CONTRACT_NOT_PROVIDED",
                    "Contract '\(contractId)' not provided in scope \(scope.serialized()) after \(readinessTimeoutMs)ms",
                    contractId, member, scope
                )
            }
            lock.lock()
            binding = resolveBinding(contractId: contractId, scope: scope)
            lock.unlock()
            guard let b = binding else {
                return Self.errEnv("CONTRACT_NOT_PROVIDED",
                    "Contract '\(contractId)' vanished after park", contractId, member, scope)
            }
            binding = b
        }

        guard let b = binding else {
            return Self.errEnv("CONTRACT_NOT_PROVIDED", "No binding", contractId, member, scope)
        }

        if let hashErr = checkContractHash(contractId: contractId, member: member, scope: scope, binding: b, env: env) {
            return hashErr
        }

        do {
            // INV-10: BridgeKitDecodeError → VALIDATION_FAILED.
            let result = try await withBridgeTimeout(nanoseconds: callTimeoutMs * 1_000_000) {
                try await b.adapter.invoke(member: member, payload: payload)
            }
            return Self.okEnv(result)
        } catch let e as BridgeKitDecodeError {
            // INV-10.
            return Self.errEnv("VALIDATION_FAILED", "Decode failed for '\(member)' on '\(contractId)': \(e.description)", contractId, member, scope)
        } catch let e as BridgeKitError where e.code == "TIMEOUT" {
            return Self.errEnv("TIMEOUT", "Call to '\(member)' on '\(contractId)' timed out after \(callTimeoutMs)ms", contractId, member, scope)
        } catch let e as BridgeKitError where e.code == "METHOD_NOT_FOUND" {
            return Self.errEnv("METHOD_NOT_FOUND", "Unknown member '\(member)' on '\(contractId)': \(e.message)", contractId, member, scope)
        } catch {
            return Self.errEnv("PROVIDER_ERROR", "\(type(of: error)): \(error.localizedDescription)", contractId, member, scope)
        }
    }

    private func buildNativeStateSnapshot() -> [[String: Any?]] {
        lock.lock()
        let liveBindings = bindings.values.filter { $0.isLive }
        lock.unlock()
        var snapshot: [[String: Any?]] = []
        for entry in liveBindings {
            for (stateKey, _) in entry.adapter.stateInitials {
                lock.lock()
                let bv = stateStore.read(contractId: entry.contractId, scope: entry.scope, stateKey: stateKey, initial: nil)
                lock.unlock()
                snapshot.append([
                    "contractId": entry.contractId,
                    "key": stateKey,
                    "scope": Self.scopeToEnvMap(entry.scope),
                    "v": bv.valueOrNil()
                ])
            }
        }
        return snapshot
    }

    /// Wire hash skew check (observe/strict modes).
    private func checkContractHash(
        contractId: String,
        member: String,
        scope: Scope,
        binding: BindingEntry,
        env: [String: Any?]
    ) -> [String: Any?]? {
        guard let callerHash = env["contractHash"] as? String else { return nil }
        let receiverHash = binding.definition.contractHash
        if callerHash == receiverHash { return nil }
        // Skew detected.
        if !strictHashCheck { return nil }
        return [
            "ok": false,
            "code": "INCOMPATIBLE_CONTRACT",
            "message": "Contract '\(contractId)' hash mismatch: caller=\(callerHash) receiver=\(receiverHash)",
            "contractId": contractId,
            "member": member,
            "scope": Self.scopeToEnvMap(scope),
            "details": ["callerHash": callerHash, "receiverHash": receiverHash]
        ]
    }

    // =========================================================================
    // Envelope helpers
    // =========================================================================

    private func parseScopeEnv(_ env: [String: Any?]) -> Scope {
        guard let scopeObj = env["scope"] as? [String: Any?] else { return .global }
        return Scope.from(envelopeMap: scopeObj)
    }

    private func extractPayload(_ env: [String: Any?]) -> [String: Any?]? {
        env["payload"] as? [String: Any?]
    }

    internal static func okEnv(_ value: Any?) -> [String: Any?] {
        ["ok": true, "value": value]
    }

    internal static func errEnv(
        _ code: String,
        _ message: String,
        _ contractId: String? = nil,
        _ member: String? = nil,
        _ scope: Scope? = nil
    ) -> [String: Any?] {
        var dict: [String: Any?] = ["ok": false, "code": code, "message": message]
        if let c = contractId { dict["contractId"] = c }
        if let m = member { dict["member"] = m }
        if let s = scope { dict["scope"] = scopeToEnvMap(s) }
        return dict
    }

    internal static func scopeToEnvMap(_ scope: Scope) -> [String: Any?] {
        switch scope {
        case .global:
            return ["kind": "global"]
        case .feature(let name):
            return ["kind": "feature", "feature": name]
        case .instance(let feature, let tag):
            return ["kind": "instance", "feature": feature, "instance": tag]
        }
    }

    // =========================================================================
    // Dump
    // =========================================================================

    internal func dump() -> String {
        lock.lock()
        defer { lock.unlock() }
        var lines: [String] = []
        lines.append("epoch=\(epochCounter) bindings=\(bindings.count) streamPumps=\(streamPumpJobs.count)")
        for (key, entry) in bindings {
            lines.append("binding|\(key)|live=\(entry.isLive)")
        }
        lines.append(parkBuffer.dump())
        lines.append(stateStore.dump())
        return lines.joined(separator: "\n")
    }
}
