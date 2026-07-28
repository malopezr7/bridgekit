// SeamEncoding.swift
// Policy for what crosses the native→JS seam when a payload cannot be encoded.
//
// The Nitro callback closures are non-throwing by contract, so the adapters
// cannot propagate an encoding failure the way Android's seam does. They used
// `try?` instead, which silently discarded whatever failed — including stream
// terminals. A dropped terminal is the worst of the three outcomes: the JS
// consumer never learns the stream ended and waits forever, with no error.
//
// This file holds the decision — what to emit instead — as plain Swift so it is
// unit-testable. The AnyMap plumbing stays in ios/nitro/*, which cannot be
// tested here because NitroModules ships no SPM manifest.

import Foundation

/// Wire code emitted when a payload cannot cross the native→JS seam.
internal let SEAM_ENCODE_FAILED = "SEAM_ENCODE_FAILED"

internal enum SeamEncoding {

    /// Substitute terminal for a payload that failed to encode.
    ///
    /// Every value is a `String` or `Bool`, so this envelope is always encodable:
    /// it must not be able to fail for the same reason as the payload it replaces.
    internal static func failureTerminal(context: String, error: Error) -> [String: Any?] {
        [
            "ok": false,
            "code": SEAM_ENCODE_FAILED,
            "message": "Failed to encode \(context) for the JS seam: \(error)"
        ]
    }

    /// Human-readable warning for a seam encoding failure.
    ///
    /// iOS has no diagnostics module yet (Android does — RT-IOS parity gap), so
    /// this goes to the console. Centralised here so there is one place to
    /// redirect once diagnostics land.
    internal static func reportFailure(context: String, error: Error) {
        print("[bridgekit] seam encoding failed for \(context): \(error)")
    }
}

/// Guarantees a stream is terminated at most once.
///
/// A value that cannot be encoded terminates the stream rather than leaving a
/// silent gap in the data, which means both the value path and the end path can
/// reach `onEnd`. Only one of them may win.
internal final class SeamTerminalGuard {
    private let lock = NSLock()
    private var terminated = false

    /// Claim the terminal. Returns `true` exactly once.
    internal func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if terminated { return false }
        terminated = true
        return true
    }

    internal var isTerminated: Bool {
        lock.lock()
        defer { lock.unlock() }
        return terminated
    }
}
