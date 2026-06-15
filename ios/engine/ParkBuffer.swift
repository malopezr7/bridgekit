// ParkBuffer.swift
// BridgeKit iOS engine — park buffer for ops arriving before a contract is provided.
//
// Port of io/github/malopezr7/bridgekit/core/ParkBuffer.kt
//
// DESIGN: Waiters are OnceContinuationResult<Bool> (true = provided, false = failed).
// Bounded to MAX_PARKED=64 per (contractId, scopeKey).
//
// INV-7: removeIf{isCompleted} BEFORE the MAX_PARKED capacity check.
// This ensures timed-out/completed waiters do not permanently consume slots.

import Foundation

internal final class ParkBuffer {

    internal static let MAX_PARKED = 64

    private struct ParkKey: Hashable {
        let contractId: String
        let scopeKey: String
    }

    // Guarded by the engine-level NSRecursiveLock (passed at init).
    // ParkBuffer does not own its own lock — the Router holds the engine lock
    // around all park/unpark/failAll calls so the CopyOnWriteArrayList pattern
    // from Kotlin becomes a plain Swift array guarded by the same lock.
    //
    // PORT NOTE: Kotlin used ConcurrentHashMap<ParkKey, CopyOnWriteArrayList<Deferred>>.
    // In Swift: engine lock guards access; array is the straightforward equivalent.
    private var waiters: [ParkKey: [OnceContinuationResult<Bool>]] = [:]

    // -------------------------------------------------------------------------
    // park
    // -------------------------------------------------------------------------

    /// Park a waiter for (contractId, scope).
    ///
    /// - Returns: An `OnceContinuationResult<Bool>` that resumes `true` when the
    ///   contract is provided, or `false` when the caller should fail.
    ///   Returns `nil` if the buffer is full (caller should fail immediately).
    ///
    /// INV-7: Prunes completed waiters before the capacity check.
    ///
    /// PORT NOTE: Kotlin returns `CompletableDeferred<Boolean>?`. Swift equivalent
    /// is OnceContinuationResult<Bool> registered via `withCheckedContinuation` in
    /// the caller (Router.awaitProvided / OutboundCaller.awaitDispatcher).
    /// We store the wrapper here and return it; caller suspends on `withCheckedContinuation`
    /// passing the result into a new OnceContinuationResult.
    internal func registerWaiter(
        contractId: String,
        scope: Scope,
        cont: OnceContinuationResult<Bool>
    ) -> Bool {
        let key = ParkKey(contractId: contractId, scopeKey: scope.serialized())
        // INV-7: prune completed entries before capacity check.
        var list = waiters[key] ?? []
        list = list.filter { !$0.isConsumed }
        if list.count >= ParkBuffer.MAX_PARKED {
            return false
        }
        list.append(cont)
        waiters[key] = list
        return true
    }

    // -------------------------------------------------------------------------
    // unpark
    // -------------------------------------------------------------------------

    /// Unpark all waiters for (contractId, scope) — called when a binding is provided.
    /// Resumes each waiter with `true`.
    internal func unpark(contractId: String, scope: Scope) {
        let key = ParkKey(contractId: contractId, scopeKey: scope.serialized())
        guard let list = waiters.removeValue(forKey: key) else { return }
        for cont in list {
            cont.resume(returning: true)
        }
    }

    // -------------------------------------------------------------------------
    // failAll (per-key)
    // -------------------------------------------------------------------------

    /// Fail all waiters for (contractId, scope) with `false`.
    internal func failAll(contractId: String, scope: Scope) {
        let key = ParkKey(contractId: contractId, scopeKey: scope.serialized())
        guard let list = waiters.removeValue(forKey: key) else { return }
        for cont in list {
            cont.resume(returning: false)
        }
    }

    // -------------------------------------------------------------------------
    // failAllPending (epoch swap)
    // -------------------------------------------------------------------------

    /// Fail all parked ops across all contracts — called during epoch swap for
    /// native→JS direction (INV-2 companion: clears park buffer atomically with epoch).
    ///
    /// Port: `failAllPending()` (Kotlin).
    internal func failAllPending() {
        for (_, list) in waiters {
            for cont in list {
                cont.resume(returning: false)
            }
        }
        waiters.removeAll()
    }

    // -------------------------------------------------------------------------
    // dump
    // -------------------------------------------------------------------------

    internal func dump() -> String {
        let entries = waiters.filter { !$0.value.isEmpty }
        if entries.isEmpty { return "parked=0" }
        return entries.map { k, v in
            "parked|\(k.contractId)|\(k.scopeKey)|count=\(v.count)"
        }.joined(separator: "\n")
    }
}
