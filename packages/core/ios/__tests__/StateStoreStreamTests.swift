// StateStoreStreamTests.swift
// Parity tests for StateStore.stateStream — the surface OutboundCallerImpl.state()
// exposes to consumers.
//
// RT-IOS-09: the store tracks `.replacing(lastKnown)` and `.unprovided(lastKnown)`
// correctly, but the stream observer synthesised its value from the notification
// envelope instead of reading the authoritative state, collapsing every non-value
// notification to `.unprovided(nil)`. Consumers therefore lost `lastKnown` on
// every provider swap and could never observe `.replacing` at all — while Android
// returns the live StateFlow holding `Replacing(lastKnown)`.

import XCTest

@testable import BridgeKit

final class StateStoreStreamTests: XCTestCase {
    // StateStore borrows the engine lock as `unowned(unsafe)`, so the test must
    // keep it alive for the store's lifetime — a temporary would be freed
    // immediately and every lock() would hit released memory.
    private var lock = NSRecursiveLock()

    private let contractId = "bridgekit.test-state"
    private let stateKey = "profile"
    private let scope = Scope.global

    /// Collects the values a stream emits, up to `count`, with a timeout.
    private func collect(
        _ stream: AsyncStream<BridgeValue<Any?>>,
        count: Int,
        timeout: TimeInterval = 2.0
    ) async -> [BridgeValue<Any?>] {
        let collected = Collected()
        let task = Task {
            for await value in stream {
                if await collected.append(value) >= count { break }
            }
        }
        let deadline = Date().addingTimeInterval(timeout)
        while await collected.count() < count, Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        task.cancel()
        return await collected.values()
    }

    private actor Collected {
        private var storage: [BridgeValue<Any?>] = []
        func append(_ value: BridgeValue<Any?>) -> Int {
            storage.append(value)
            return storage.count
        }
        func count() -> Int { storage.count }
        func values() -> [BridgeValue<Any?>] { storage }
    }

    // MARK: - The divergence

    func test_streamPreservesLastKnownWhenProviderGoesAway() async {
        let store = StateStore(lock: lock)
        store.seedNativeState(contractId: contractId, scope: scope, stateKey: stateKey, initial: "seed")
        store.setNativeValue(contractId: contractId, scope: scope, stateKey: stateKey, value: "live")

        let stream = store.stateStream(
            contractId: contractId,
            scope: scope,
            stateKey: stateKey,
            initial: "seed"
        )

        // Give the stream a moment to register its observer, then drop the provider.
        Task {
            try? await Task.sleep(nanoseconds: 50_000_000)
            let snapshots = store.markUnprovided(contractId: self.contractId, scope: self.scope)
            store.notifyGoneSnapshots(snapshots)
        }

        let values = await collect(stream, count: 2)

        XCTAssertEqual(values.count, 2, "expected the current value plus the unprovided transition")
        guard values.count == 2 else { return }

        guard case .available(let first) = values[0] else {
            return XCTFail("expected .available first, got \(values[0])")
        }
        XCTAssertEqual(first as? String, "live")

        guard case .unprovided(let lastKnown) = values[1] else {
            return XCTFail("expected .unprovided after the provider went away, got \(values[1])")
        }
        XCTAssertEqual(
            lastKnown as? String,
            "live",
            "lastKnown must survive the transition — the store keeps it, the stream must not discard it"
        )
    }

    func test_streamEmitsReplacingDuringProviderSwap() async {
        let store = StateStore(lock: lock)
        store.seedNativeState(contractId: contractId, scope: scope, stateKey: stateKey, initial: "seed")
        store.setNativeValue(contractId: contractId, scope: scope, stateKey: stateKey, value: "live")

        let stream = store.stateStream(
            contractId: contractId,
            scope: scope,
            stateKey: stateKey,
            initial: "seed"
        )

        Task {
            try? await Task.sleep(nanoseconds: 50_000_000)
            let snapshots = store.markJsContractsUnprovided([self.contractId])
            for snapshot in snapshots {
                for callback in snapshot { callback(["status": "replacing"]) }
            }
        }

        let values = await collect(stream, count: 2)

        XCTAssertEqual(values.count, 2)
        guard values.count == 2 else { return }

        guard case .replacing(let lastKnown) = values[1] else {
            return XCTFail(
                "expected .replacing during a provider swap, got \(values[1]) — Android surfaces Replacing(lastKnown) here"
            )
        }
        XCTAssertEqual(lastKnown as? String, "live")
    }

    // MARK: - Guard against regressing the working path

    func test_streamStillDeliversValues() async {
        let store = StateStore(lock: lock)
        store.seedNativeState(contractId: contractId, scope: scope, stateKey: stateKey, initial: "seed")

        let stream = store.stateStream(
            contractId: contractId,
            scope: scope,
            stateKey: stateKey,
            initial: "seed"
        )

        Task {
            try? await Task.sleep(nanoseconds: 50_000_000)
            store.setNativeValue(contractId: self.contractId, scope: self.scope, stateKey: self.stateKey, value: "next")
        }

        let values = await collect(stream, count: 2)

        XCTAssertEqual(values.count, 2)
        guard values.count == 2 else { return }
        guard case .available(let latest) = values[1] else {
            return XCTFail("expected .available, got \(values[1])")
        }
        XCTAssertEqual(latest as? String, "next")
    }
}
