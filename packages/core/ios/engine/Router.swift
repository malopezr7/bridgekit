// Router.swift
// BridgeKit iOS engine — routing engine implementing BridgeKitNativeDelegate.
//
// CONCURRENCY MODEL: ONE shared NSRecursiveLock runs all sync-returning paths.
// Async Tasks only for: invoke, stream pumps, OutboundCaller calls, grace timer.
// Do NOT make Router an actor — it deadlocks sync specs on the JS thread.

import Foundation

// MARK: - JsDispatcherCallbacks

/// Callbacks that the dispatcher passes back to JS.
final class JsDispatcherCallbacks {
    let onInvoke: (
        _ env: [String: Any?],
        _ completion: @escaping (_ ok: [String: Any?]?, _ err: Error?) -> Void
    ) -> Void

    let onStreamOpen:  (_ env: [String: Any?]) -> Void
    let onStreamClose: (_ env: [String: Any?]) -> Void
    let onStateWrite:  (_ env: [String: Any?]) -> Void

    init(
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

// MARK: - JS stream channel types

/// Bidirectional async pipe for one JS→native stream.
typealias JsStreamChannel = (
    stream: AsyncStream<[String: Any?]>,
    continuation: AsyncStream<[String: Any?]>.Continuation
)

// MARK: - Router

internal final class Router {

    // MARK: Engine lock

    /// All sync paths run fully inside this lock. Never hold it across an `await`.
    internal let lock = NSRecursiveLock()

    // MARK: Configuration

    internal let readinessTimeoutMs: UInt64
    internal let callTimeoutMs: UInt64
    internal let strictHashCheck: Bool

    // MARK: Binding registry

    // (contractId, scopeKey) → BindingEntry — guarded by lock.
    private var bindings: [String: BindingEntry] = [:]

    private func bindingKey(contractId: String, scope: Scope) -> String {
        "\(contractId)|\(scope.serialized())"
    }

    // MARK: Epoch

    // Incremented only inside connectDispatcher (under lock).
    private var epochCounter: Int64 = 0
    private var readinessSeq: Int64 = 0
    internal func currentEpoch() -> Int64 {
        lock.lock(); defer { lock.unlock() }
        return epochCounter
    }

    // MARK: JS dispatcher

    // All reads under lock; written in connectDispatcher under lock.
    private var jsCallbacks: JsDispatcherCallbacks? = nil

    internal func getJsCallbacks() -> JsDispatcherCallbacks? {
        lock.lock(); defer { lock.unlock() }
        return jsCallbacks
    }

    // MARK: JS-consume stream tracking

    // Value is (AsyncStream, its continuation) so emitFromJs can push values.
    internal var jsStreamChannels: [String: JsStreamChannel] = [:]
    internal var jsStreamEndContinuations: [String: AsyncStream<[String: Any?]>.Continuation] = [:]

    // MARK: Native→JS stream pump tracking

    // streamId → (epoch, task)
    private var streamPumpJobs: [String: (Int64, Task<Void, Never>)] = [:]

    // MARK: StreamHub

    private var streamHub: StreamHub

    // MARK: JS-provided contract set (guarded by lock)

    private var jsProvidedContracts: Set<String> = []
    private var finalClosedBindings: Set<String> = []

    private func providedKey(contractId: String, scope: Scope) -> String {
        bindingKey(contractId: contractId, scope: scope)
    }

    // MARK: StateStore

    internal let stateStore: StateStore

    // MARK: ParkBuffer

    private let parkBuffer: ParkBuffer

    // MARK: - Init

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

    // MARK: - BridgeKitNativeDelegate

    // MARK: invoke (async)

    /// Async invoke. Calls `complete` exactly once.
    ///
    /// Epoch guard: reject stale ops before side-effects. epochEnv == 0 is the
    /// pre-connection sentinel and is never rejected.
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
            // Epoch guard.
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

    // MARK: invokeSync

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
            let result = try binding.adapter.invokeSync(member: member, payload: payload)
            return Self.okEnv(result)
        } catch let e as BridgeKitDecodeError {
            return Self.errEnv("VALIDATION_FAILED", "Decode failed for '\(member)' on '\(contractId)': \(e.description)", contractId, member, scope)
        } catch let e as BridgeKitError where e.code == "METHOD_NOT_FOUND" {
            return Self.errEnv("METHOD_NOT_FOUND", "No sync method '\(member)' in contract '\(contractId)': \(e.message)", contractId, member, scope)
        } catch {
            return Self.errEnv("PROVIDER_ERROR", "Sync call failed: \(error.localizedDescription)", contractId, member, scope)
        }
    }

    // MARK: connectDispatcher

    /// Register the JS dispatcher for a new runtime epoch.
    /// Returns { epoch: Number, snapshot: [...] }.
    ///
    /// Epoch increment and stream channel teardown are atomic (both under lock).
    func connectDispatcher(
        epochInfo: [String: Any?],
        callbacks: JsDispatcherCallbacks
    ) -> [String: Any?] {
        let snapshot: [[String: Any?]]
        let nativeProvided: [[String: Any?]]

        lock.lock()

        epochCounter += 1
        let newEpoch = epochCounter

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

        // Close all JS→native stream channels (atomic with epoch increment, both inside lock).
        for (_, channel) in jsStreamChannels {
            channel.continuation.finish()
        }
        jsStreamChannels.removeAll()
        for (_, endCont) in jsStreamEndContinuations {
            endCont.yield(["ok": false, "code": "BRIDGE_NOT_READY", "message": "Epoch swap: prior stream invalidated"])
            endCont.finish()
        }
        jsStreamEndContinuations.removeAll()

        parkBuffer.failAllPending()

        let goneSnapshots = stateStore.markJsContractsUnprovided(Set(jsProvidedContracts.map { contractId(fromProvidedKey: $0) }))
        jsProvidedContracts.removeAll()
        stateStore.clearObserversForEpoch(newEpoch - 1)
        jsCallbacks = callbacks

        snapshot = buildNativeStateSnapshotLocked()
        nativeProvided = buildNativeProvidedLocked()

        lock.unlock()

        // Notify observers OUTSIDE lock.
        stateStore.notifyGoneSnapshots(goneSnapshots)

        return [
            "epoch": newEpoch,
            "snapshot": snapshot,
            "nativeProvided": nativeProvided
        ]
    }

    // MARK: openStream

    /// Open a native→JS stream. Returns the stream id.
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

        // Epoch guard.
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

        let pHash = paramsHash(payload)
        let streamId = "\(contractId)_\(member)_\(pHash)_\(mach_absolute_time())"

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

        // registerStreamJob rechecks isLive after insert; if the binding died in the
        // window between the check above and here, the job is cancelled immediately.
        binding.registerStreamJob(streamId, job: consumerTask)

        lock.unlock()
        return streamId
    }

    // MARK: closeStream

    func closeStream(streamId: String) {
        lock.lock()
        let entry = streamPumpJobs.removeValue(forKey: streamId)
        lock.unlock()
        entry?.1.cancel()
    }

    // MARK: emitFromJs

    func emitFromJs(streamId: String, value: [String: Any?]) {
        lock.lock()
        let channel = jsStreamChannels[streamId]
        lock.unlock()
        // AsyncStream yields are non-blocking; if the consumer cancelled, this is a no-op.
        channel?.continuation.yield(value)
    }

    // MARK: endFromJs

    func endFromJs(streamId: String, end: [String: Any?]) {
        lock.lock()
        let endCont = jsStreamEndContinuations[streamId]
        lock.unlock()
        endCont?.yield(end)
        endCont?.finish()
    }

    // MARK: stateRead

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

    // MARK: stateObserve

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

    // MARK: stateUnobserve

    func stateUnobserve(obsId: String) {
        lock.lock()
        defer { lock.unlock() }
        stateStore.unobserve(obsId)
    }

    // MARK: stateWrite

    /// Provider-side state write from JS.
    func stateWrite(env: [String: Any?]) -> [String: Any?] {
        lock.lock()

        guard let contractId = env["contractId"] as? String else {
            lock.unlock()
            return Self.errEnv("CONTRACT_NOT_PROVIDED", "Missing contractId")
        }
        let scope = parseScopeEnv(env)
        let op = env["op"] as? String

        let epochEnv = (env["epoch"] as? NSNumber)?.int64Value ?? 0
        if epochEnv != 0 && epochEnv < epochCounter {
            lock.unlock()
            return Self.errEnv("BRIDGE_NOT_READY",
                "Stale epoch: request epoch=\(epochEnv) current=\(epochCounter)", contractId)
        }

        if op == "provide" {
            let nativeOwns = resolveBinding(contractId: contractId, scope: scope) != nil
            if !nativeOwns {
                markJsProvided(contractId, scope: scope)
                parkBuffer.unparkProvided(contractId: contractId, providedScope: scope)
            }
            lock.unlock()
            return Self.okEnv(nil)
        }

        if op == "unprovide" {
            jsProvidedContracts.remove(providedKey(contractId: contractId, scope: scope))
            let goneSnapshots = stateStore.markJsContractsUnprovided([contractId])
            lock.unlock()
            // Notify outside lock.
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
            markJsProvided(contractId, scope: scope)
            parkBuffer.unparkProvided(contractId: contractId, providedScope: scope)
        }
        let result = stateStore.writeFromJs(
            contractId: contractId, scope: scope, stateKey: stateKey,
            value: value, nativeOwnsBinding: nativeOwns
        )
        lock.unlock()
        return result
    }

    // MARK: - Internal API

    /// Register a native provider binding.
    /// If a binding already exists, it is closed with .replacing and replaced.
    internal func registerBinding(_ entry: BindingEntry) {
        lock.lock()
        let key = bindingKey(contractId: entry.contractId, scope: entry.scope)
        finalClosedBindings.remove(key)
        let previous = bindings[key]
        bindings[key] = entry

        if let prev = previous, prev.isLive {
            prev.close(reason: .replacing)
        }

        // Seed state store with initial values.
        for (stateKey, initial) in entry.adapter.stateInitials {
            stateStore.seedNativeState(contractId: entry.contractId, scope: entry.scope, stateKey: stateKey, initial: initial)
        }
        parkBuffer.unparkProvided(contractId: entry.contractId, providedScope: entry.scope)
        let callbacks = jsCallbacks
        let delta = readinessDelta(op: "provide", contractId: entry.contractId, scope: entry.scope, epoch: epochCounter)
        lock.unlock()

        callbacks?.onStateWrite(delta)

        // Subscribe to each provider state stream. One Task per stream, stored in the
        // binding so they cancel on binding.close(). Acquire the lock to write state and
        // snapshot observers, then release BEFORE calling callbacks (avoids holding the
        // engine lock across JS/Nitro callbacks).
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
                    // Notify OUTSIDE lock.
                    for cb in snapshot { cb(["v": value]) }
                }
            }
            lock.lock()
            entry.addStateObservation(task)
            lock.unlock()
        }

    }

    /// Resolve binding with instance→feature→global fallback. Called under lock.
    internal func resolveBinding(contractId: String, scope: Scope) -> BindingEntry? {
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
        let removed = bindings[key] === entry
        if removed { bindings.removeValue(forKey: key) }
        let goneSnapshots = stateStore.markUnprovided(contractId: entry.contractId, scope: entry.scope)
        entry.cancelAllStreamJobs()
        if removed && entry.closeReason == .final_ {
            finalClosedBindings.insert(key)
        }
        let callbacks = jsCallbacks
        let delta = removed ? readinessDelta(op: "unprovide", contractId: entry.contractId, scope: entry.scope, epoch: epochCounter) : nil
        lock.unlock()
        // Notify observers OUTSIDE lock.
        stateStore.notifyGoneSnapshots(goneSnapshots)
        if let delta { callbacks?.onStateWrite(delta) }
    }

    /// Await until (contractId, scope) is provided, with timeout.
    internal func awaitProvided(contractId: String, scope: Scope, timeoutMs: UInt64) async -> Bool {
        lock.lock()
        if resolveBinding(contractId: contractId, scope: scope) != nil { lock.unlock(); return true }
        if isJsProvided(contractId: contractId, scope: scope) { lock.unlock(); return true }
        if isFinalClosed(contractId: contractId, scope: scope) { lock.unlock(); return false }

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
            || isJsProvided(contractId: contractId, scope: scope)
    }

    internal func markJsProvided(_ contractId: String) {
        // Called under lock.
        markJsProvided(contractId, scope: .global)
    }

    internal func markJsProvided(_ contractId: String, scope: Scope) {
        // Called under lock.
        jsProvidedContracts.insert(providedKey(contractId: contractId, scope: scope))
    }

    // MARK: - Private helpers

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
            if isFinalClosed(contractId: contractId, scope: scope) {
                return Self.errEnv("CONTRACT_NOT_PROVIDED", "Contract '\(contractId)' not provided", contractId, member, scope)
            }
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
            let result = try await withBridgeTimeout(nanoseconds: callTimeoutMs * 1_000_000) {
                try await b.adapter.invoke(member: member, payload: payload)
            }
            return Self.okEnv(result)
        } catch let e as BridgeKitDecodeError {
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
        let snapshot = buildNativeStateSnapshotLocked()
        lock.unlock()
        return snapshot
    }

    private func buildNativeStateSnapshotLocked() -> [[String: Any?]] {
        let liveBindings = bindings.values.filter { $0.isLive }
        var snapshot: [[String: Any?]] = []
        for entry in liveBindings {
            for (stateKey, _) in entry.adapter.stateInitials {
                let bv = stateStore.read(contractId: entry.contractId, scope: entry.scope, stateKey: stateKey, initial: nil)
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

    private func buildNativeProvidedLocked() -> [[String: Any?]] {
        bindings.values.filter { $0.isLive }.map { entry in
            [
                "contractId": entry.contractId,
                "scope": Self.scopeToEnvMap(entry.scope)
            ]
        }
    }

    private func isJsProvided(contractId: String, scope: Scope) -> Bool {
        candidateScopes(scope).contains { candidate in
            jsProvidedContracts.contains(providedKey(contractId: contractId, scope: candidate))
        }
    }

    private func isFinalClosed(contractId: String, scope: Scope) -> Bool {
        lock.lock(); defer { lock.unlock() }
        // Explicit return: the lock/defer statements make this a multi-statement
        // body, so Swift's single-expression implicit return does not apply.
        return candidateScopes(scope).contains { candidate in
            finalClosedBindings.contains(bindingKey(contractId: contractId, scope: candidate))
        }
    }

    private func candidateScopes(_ scope: Scope) -> [Scope] {
        switch scope {
        case .instance(let feature, _):
            return [scope, .feature(feature), .global]
        case .feature:
            return [scope, .global]
        case .global:
            return [.global]
        }
    }

    private func readinessDelta(op: String, contractId: String, scope: Scope, epoch: Int64) -> [String: Any?] {
        readinessSeq += 1
        // Explicit annotation: the literal is heterogeneous (String, map, Int64),
        // and Swift will not infer [String: Any?] from the return type alone.
        let delta: [String: Any?] = [
            "op": op,
            "contractId": contractId,
            "scope": Self.scopeToEnvMap(scope),
            "epoch": epoch,
            "seq": readinessSeq,
            "member": "",
            "correlationId": ""
        ]
        return delta
    }

    private func contractId(fromProvidedKey key: String) -> String {
        String(key.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
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

    // MARK: - Envelope helpers

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

    // MARK: - Dump

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
