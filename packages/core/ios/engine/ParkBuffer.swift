// ParkBuffer.swift
// BridgeKit iOS engine — park buffer for ops arriving before a contract is provided.
//
// Waiters are OnceContinuationResult<Bool> (true = provided, false = timed out).
// Bounded to MAX_PARKED=64 per (contractId, scopeKey).
// Completed waiters are pruned BEFORE the capacity check so timeouts don't eat slots.

import Foundation

internal final class ParkBuffer {

    internal static let MAX_PARKED = 64

    private struct ParkKey: Hashable {
        let contractId: String
        let scopeKey: String
    }

    // Guarded by the engine NSRecursiveLock (Router holds it around all park/unpark/failAll calls).
    private var waiters: [ParkKey: [OnceContinuationResult<Bool>]] = [:]

    // MARK: - registerWaiter

    /// Register a waiter for (contractId, scope).
    ///
    /// Returns `true` if the waiter was registered, `false` if the buffer is full.
    /// Prunes completed waiters before the capacity check.
    internal func registerWaiter(
        contractId: String,
        scope: Scope,
        cont: OnceContinuationResult<Bool>
    ) -> Bool {
        let key = ParkKey(contractId: contractId, scopeKey: scope.serialized())
        var list = waiters[key] ?? []
        list = list.filter { !$0.isConsumed }
        if list.count >= ParkBuffer.MAX_PARKED {
            return false
        }
        list.append(cont)
        waiters[key] = list
        return true
    }

    // MARK: - unpark

    /// Resume all waiters for (contractId, scope) with `true`.
    internal func unpark(contractId: String, scope: Scope) {
        let key = ParkKey(contractId: contractId, scopeKey: scope.serialized())
        guard let list = waiters.removeValue(forKey: key) else { return }
        for cont in list {
            cont.resume(returning: true)
        }
    }

    // MARK: - failAll (per-key)

    /// Fail all waiters for (contractId, scope) with `false`.
    internal func failAll(contractId: String, scope: Scope) {
        let key = ParkKey(contractId: contractId, scopeKey: scope.serialized())
        guard let list = waiters.removeValue(forKey: key) else { return }
        for cont in list {
            cont.resume(returning: false)
        }
    }

    // MARK: - failAllPending (epoch swap)

    /// Fail all parked ops across all contracts — called during epoch swap.
    internal func failAllPending() {
        for (_, list) in waiters {
            for cont in list {
                cont.resume(returning: false)
            }
        }
        waiters.removeAll()
    }

    // MARK: - dump

    internal func dump() -> String {
        let entries = waiters.filter { !$0.value.isEmpty }
        if entries.isEmpty { return "parked=0" }
        return entries.map { k, v in
            "parked|\(k.contractId)|\(k.scopeKey)|count=\(v.count)"
        }.joined(separator: "\n")
    }
}
