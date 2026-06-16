// OnceContinuation.swift
// BridgeKit iOS engine — single-resume guard for Swift CheckedContinuation.
//
// Swift crashes on double-resume of a CheckedContinuation. This wrapper provides
// idempotency by nil-ing out the continuation after the first resume.
//
// Used by ParkBuffer (unpark/failAll/timeout race), OutboundCaller (callback/timeout
// race), and stream end deferreds (endFromJs/epoch-swap race).

import Foundation

/// A wrapper around `CheckedContinuation` that guarantees at-most-one resume.
///
/// Thread-safe via NSLock; safe for concurrent calls from Nitro callbacks, timer
/// tasks, and epoch-swap tasks.
internal final class OnceContinuation<T> {

    // NSLock (not NSRecursiveLock): only locked for the nil-and-resume critical
    // section, never re-entered.
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
