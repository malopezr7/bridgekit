// SeamEncodingTests.swift
// RT-IOS-03: the native→JS seam swallowed anything that failed to encode.
//
// Nine `try?` sites in ios/nitro/* dropped the payload on failure. For a stream
// terminal that is the worst outcome available: the JS consumer never learns the
// stream ended and waits forever with no error, while Android throws at the
// equivalent seam.
//
// The adapters themselves cannot be tested here — they import NitroModules,
// which ships no SPM manifest — so the policy they apply lives in
// ios/engine/SeamEncoding.swift and is tested directly.

import XCTest

@testable import BridgeKit

final class SeamEncodingTests: XCTestCase {
    private struct Unencodable: Error, CustomStringConvertible {
        var description: String { "value is not representable as AnyMap" }
    }

    // MARK: - The substitute terminal

    func test_failureTerminalIsAWellFormedErrorEnvelope() {
        let envelope = SeamEncoding.failureTerminal(context: "stream end", error: Unencodable())

        XCTAssertEqual(envelope["ok"] as? Bool, false)
        XCTAssertEqual(envelope["code"] as? String, SEAM_ENCODE_FAILED)

        let message = envelope["message"] as? String
        XCTAssertNotNil(message)
        XCTAssertTrue(
            message?.contains("stream end") == true,
            "the message must name what failed so the failure is diagnosable from JS"
        )
        XCTAssertTrue(
            message?.contains("not representable") == true,
            "the message must carry the underlying error"
        )
    }

    /// The substitute must not be able to fail for the same reason as the payload
    /// it replaces, or a dropped terminal simply becomes a dropped substitute.
    func test_failureTerminalContainsOnlyPrimitivelyEncodableValues() {
        let envelope = SeamEncoding.failureTerminal(context: "any", error: Unencodable())

        for (key, value) in envelope {
            switch value {
            case is String, is Bool:
                continue
            default:
                XCTFail("'\(key)' is \(type(of: value as Any)); the fallback envelope must be strings and bools only")
            }
        }
    }

    func test_failureTerminalMatchesTheWireErrorShape() {
        let envelope = SeamEncoding.failureTerminal(context: "any", error: Unencodable())
        XCTAssertEqual(
            Set(envelope.keys),
            ["ok", "code", "message"],
            "must match the { ok, code, message } envelope the rest of the engine emits"
        )
    }

    // MARK: - At-most-once termination

    func test_terminalGuardClaimsExactlyOnce() {
        let guardian = SeamTerminalGuard()

        XCTAssertFalse(guardian.isTerminated)
        XCTAssertTrue(guardian.claim(), "the first claim wins")
        XCTAssertTrue(guardian.isTerminated)
        XCTAssertFalse(guardian.claim(), "a second claim must lose")
        XCTAssertFalse(guardian.claim())
    }

    /// Both the value path and the end path can reach onEnd, and Nitro callbacks
    /// arrive on arbitrary threads.
    func test_terminalGuardIsSafeUnderConcurrentClaims() {
        let guardian = SeamTerminalGuard()
        let winners = NSMutableArray()
        let winnersLock = NSLock()

        DispatchQueue.concurrentPerform(iterations: 200) { _ in
            if guardian.claim() {
                winnersLock.lock()
                winners.add(true)
                winnersLock.unlock()
            }
        }

        XCTAssertEqual(winners.count, 1, "exactly one claimant may terminate the stream")
    }
}
