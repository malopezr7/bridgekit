// BridgeTimeoutTests.swift
// RT-IOS-01: withBridgeTimeout could never actually time out.
//
// `try await group.next()!` propagates the timeout child's error immediately, so
// `group.cancelAll()` on the next line never runs. withThrowingTaskGroup then
// awaits its remaining children as the closure unwinds — and the operation child
// is typically suspended on a continuation waiting for a JS reply that is never
// coming. The caller hangs forever instead of receiving TIMEOUT.
//
// Android enforces the same declared callTimeoutMs with withTimeout and works.

import XCTest

@testable import BridgeKit

final class BridgeTimeoutTests: XCTestCase {
    /// Captures the outcome of a task without awaiting it, so a hung operation
    /// fails this test with a diagnosis instead of hanging the whole suite.
    private actor Outcome {
        private var value: Result<Int, Error>?
        func set(_ result: Result<Int, Error>) { if value == nil { value = result } }
        func get() -> Result<Int, Error>? { value }
    }

    private func awaitOutcome(_ outcome: Outcome, timeout: TimeInterval) async -> Result<Int, Error>? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let result = await outcome.get() { return result }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return nil
    }

    // MARK: - The divergence

    func test_timesOutEvenWhenTheOperationNeverCompletes() async {
        let outcome = Outcome()

        // Deliberately models a bridge call parked on a reply that never arrives:
        // a plain checked continuation, which does not observe cancellation.
        let task = Task {
            do {
                let value = try await withBridgeTimeout(nanoseconds: 100_000_000) {
                    try await withCheckedThrowingContinuation { (_: CheckedContinuation<Int, Error>) in }
                }
                await outcome.set(.success(value))
            } catch {
                await outcome.set(.failure(error))
            }
        }
        defer { task.cancel() }

        guard let result = await awaitOutcome(outcome, timeout: 3.0) else {
            return XCTFail(
                "withBridgeTimeout never returned. The timeout child threw, so cancelAll() was skipped and the group is still awaiting an operation that will never finish."
            )
        }

        switch result {
        case .success(let value):
            XCTFail("expected TIMEOUT, got value \(value)")
        case .failure(let error):
            guard let bridgeError = error as? BridgeKitError else {
                return XCTFail("expected BridgeKitError, got \(error)")
            }
            XCTAssertEqual(bridgeError.code, "TIMEOUT")
        }
    }

    func test_timeoutCancelsTheAbandonedOperation() async {
        let started = Outcome()
        let cancelled = Outcome()

        let task = Task {
            _ = try? await withBridgeTimeout(nanoseconds: 100_000_000) {
                await started.set(.success(1))
                // Cancellation-aware: the timeout must actually reach it.
                try await withTaskCancellationHandler {
                    try await Task.sleep(nanoseconds: 30_000_000_000)
                    return 0
                } onCancel: {
                    Task { await cancelled.set(.success(1)) }
                }
            }
        }
        defer { task.cancel() }

        _ = await awaitOutcome(started, timeout: 2.0)
        guard await awaitOutcome(cancelled, timeout: 3.0) != nil else {
            return XCTFail("the abandoned operation was never cancelled after the timeout fired")
        }
    }

    // MARK: - Guard against regressing the working paths

    func test_returnsValueWhenOperationBeatsTheTimeout() async throws {
        let value = try await withBridgeTimeout(nanoseconds: 5_000_000_000) { 42 }
        XCTAssertEqual(value, 42)
    }

    func test_propagatesOperationErrorRatherThanTimeout() async {
        struct Boom: Error {}
        do {
            _ = try await withBridgeTimeout(nanoseconds: 5_000_000_000) { () async throws -> Int in
                throw Boom()
            }
            XCTFail("expected the operation error to propagate")
        } catch is Boom {
            // expected
        } catch {
            XCTFail("expected Boom, got \(error)")
        }
    }
}
