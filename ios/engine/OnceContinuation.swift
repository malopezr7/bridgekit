// OnceContinuation.swift
// BridgeKit iOS engine — single-resume guard for Swift CheckedContinuation.
//
// DESIGN (Decision 4): Swift crashes on double-resume of a CheckedContinuation
// (verified: Promise.swift:46-47,57-58; withUnsafeThrowingContinuation:188).
// Kotlin CompletableDeferred.complete() is idempotent — all concurrent completers
// race safely. This wrapper provides the same idempotency in Swift by nil-ing out
// the continuation after the first resume so subsequent calls are no-ops.
//
// Used by:
//  - ParkBuffer: concurrent unpark vs failAllPending vs timeout race.
//  - OutboundCaller: completion callback vs callTimeout race.
//  - Stream end deferreds: endFromJs vs epoch-swap close race.

import Foundation

/// A wrapper around `CheckedContinuation` that guarantees at-most-one resume.
///
/// Port: The Kotlin CompletableDeferred.complete() idempotency → Swift needs
/// an explicit wrapper because `CheckedContinuation` is single-use by contract.
///
/// Thread safety: protected by `NSLock`; safe for concurrent resume calls
/// from arbitrary threads (Nitro callbacks, timer tasks, epoch-swap tasks).
internal final class OnceContinuation<T> {

    // PORT NOTE: NSLock (not NSRecursiveLock) — this wrapper is only ever
    // locked for the tiny critical section of nil-and-resume, never re-entered.
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?

    internal init(_ continuation: CheckedContinuation<T, Error>) {
        self.continuation = continuation
    }

    /// Resume the continuation with a value (at most once). Subsequent calls are no-ops.
    internal func resume(returning value: T) {
        lock.lock()
        guard let cont = continuation else { lock.unlock(); return }
        continuation = nil
        lock.unlock()
        cont.resume(returning: value)
    }

    /// Resume the continuation with an error (at most once). Subsequent calls are no-ops.
    internal func resume(throwing error: Error) {
        lock.lock()
        guard let cont = continuation else { lock.unlock(); return }
        continuation = nil
        lock.unlock()
        cont.resume(throwing: error)
    }

    /// True if this continuation has already been resumed.
    internal var isConsumed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return continuation == nil
    }
}

/// Variant for non-throwing continuations (e.g. ParkBuffer park → Bool result).
internal final class OnceContinuationResult<T> {

    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?

    internal init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = continuation
    }

    internal func resume(returning value: T) {
        lock.lock()
        guard let cont = continuation else { lock.unlock(); return }
        continuation = nil
        lock.unlock()
        cont.resume(returning: value)
    }

    internal var isConsumed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return continuation == nil
    }
}
