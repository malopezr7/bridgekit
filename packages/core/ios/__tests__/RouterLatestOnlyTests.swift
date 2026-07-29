// RouterLatestOnlyTests.swift
// The `latestOnly` / `sticky` stream flags were declarable in a contract and
// silently inert.
//
// The chain was complete except for one link: `t.stream(..., { latestOnly: true })`
// is accepted by the JS contract API, the JS runtime puts the flag on the
// open-stream envelope, Nitro transports it, and StreamHub implements the replay
// it asks for. The native Router received the envelope and never read the flag,
// so it never reached attach() and a late subscriber got nothing.

import XCTest

@testable import BridgeKit

final class RouterLatestOnlyTests: XCTestCase {

    private final class TestDefinition: AnyBridgeContractDefinition {
        let id: String
        let contractHash = "test-hash"
        let memberHashes: [String: String] = [:]
        init(id: String) { self.id = id }
    }

    /// Emits one value, then stays open so a late subscriber can attach.
    private final class OneValueStreamAdapter: InboundContractAdapter {
        var stateInitials: [String: Any?] { [:] }
        func invoke(member: String, payload: [String: Any?]?) async throws -> Any? { nil }
        func invokeSync(member: String, payload: [String: Any?]?) throws -> Any? { nil }
        func stateStreams() -> [String: AsyncStream<Any?>] { [:] }

        func openStream(member: String, payload: [String: Any?]?) -> AsyncThrowingStream<Any?, Error> {
            AsyncThrowingStream { continuation in
                continuation.yield("first")
                // Deliberately left open.
            }
        }
    }

    private func makeRouterWithStream() -> Router {
        let router = Router()
        router.registerBinding(
            BindingEntry(
                definition: TestDefinition(id: "bridgekit.ticks"),
                scope: .global,
                adapter: OneValueStreamAdapter()
            )
        )
        return router
    }

    private func openStream(
        on router: Router,
        latestOnly: Bool,
        onNext: @escaping ([String: Any?]) -> Void
    ) -> String {
        var env: [String: Any?] = ["contractId": "bridgekit.ticks", "member": "ticks"]
        if latestOnly { env["latestOnly"] = true }
        return router.openStream(env: env, onNext: onNext, onEnd: { _ in })
    }

    /// Spin the run loop briefly so the detached upstream task can produce.
    private func settle(_ seconds: TimeInterval = 0.3) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    private func waitFor(timeout: TimeInterval = 2.0, _ predicate: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate(), Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
    }

    // MARK: - The wiring

    func test_latestOnlyReplaysTheLastValueToALateSubscriber() {
        let router = makeRouterWithStream()
        let received = NSMutableArray()
        let lock = NSLock()

        // First subscriber starts the upstream and consumes the value.
        _ = openStream(on: router, latestOnly: true) { _ in }
        settle()  // let the upstream produce and the hub retain it

        // Late subscriber on the same contract/member/params joins the same hub.
        _ = openStream(on: router, latestOnly: true) { env in
            lock.lock()
            received.add(env["v"] as? String ?? "<none>")
            lock.unlock()
        }

        waitFor {
            lock.lock(); defer { lock.unlock() }
            return received.count > 0
        }

        lock.lock()
        let count = received.count
        lock.unlock()

        XCTAssertGreaterThan(
            count,
            0,
            "latestOnly was requested on the open envelope but the late subscriber received no replay — the Router is not passing the flag to StreamHub"
        )
    }

    func test_withoutLatestOnlyALateSubscriberGetsNoReplay() {
        let router = makeRouterWithStream()
        let received = NSMutableArray()
        let lock = NSLock()

        _ = openStream(on: router, latestOnly: false) { _ in }
        settle()

        _ = openStream(on: router, latestOnly: false) { env in
            lock.lock()
            received.add(env["v"] as? String ?? "<none>")
            lock.unlock()
        }

        // Give it the same window the positive case gets.
        waitFor(timeout: 0.5) {
            lock.lock(); defer { lock.unlock() }
            return received.count > 0
        }

        lock.lock()
        let count = received.count
        lock.unlock()

        XCTAssertEqual(count, 0, "a plain stream must not replay to late subscribers")
    }
}
