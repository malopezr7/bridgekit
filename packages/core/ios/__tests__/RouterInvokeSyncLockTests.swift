// RouterInvokeSyncLockTests.swift
// RT-IOS-05: invokeSync held the engine lock across provider execution.
//
// `lock.lock(); defer { lock.unlock() }` at the top of the function meant the
// global NSRecursiveLock was still held while `binding.adapter.invokeSync(...)`
// ran arbitrary provider code. A slow or blocking sync provider froze the entire
// Router: no other invoke, stream open, state operation or binding change could
// proceed on any thread.
//
// Android's equivalent (Router.kt:127-149) takes no lock at all, and iOS's own
// async path already resolves the binding under the lock and releases it before
// doing the work. invokeSync was the outlier.

import XCTest

@testable import BridgeKit

final class RouterInvokeSyncLockTests: XCTestCase {

    // MARK: - Doubles

    private final class TestDefinition: AnyBridgeContractDefinition {
        let id: String
        let contractHash: String
        let memberHashes: [String: String]

        init(id: String, contractHash: String = "test-hash") {
            self.id = id
            self.contractHash = contractHash
            self.memberHashes = [:]
        }
    }

    /// Blocks inside invokeSync until the test releases it, so the test can
    /// observe whether the rest of the Router is reachable meanwhile.
    private final class BlockingAdapter: InboundContractAdapter {
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)

        var stateInitials: [String: Any?] { [:] }

        func invoke(member: String, payload: [String: Any?]?) async throws -> Any? { nil }

        func invokeSync(member: String, payload: [String: Any?]?) throws -> Any? {
            entered.signal()
            _ = release.wait(timeout: .now() + 5)
            return "done"
        }

        func openStream(member: String, payload: [String: Any?]?) -> AsyncThrowingStream<Any?, Error> {
            AsyncThrowingStream { $0.finish() }
        }

        func stateStreams() -> [String: AsyncStream<Any?>] { [:] }
    }

    /// No JS dispatcher is connected: these tests exercise the native-provider
    /// path, which never reaches JS.
    private func makeRouter() -> Router { Router() }

    private func provide(_ router: Router, contractId: String, adapter: InboundContractAdapter) {
        router.registerBinding(
            BindingEntry(
                definition: TestDefinition(id: contractId),
                scope: .global,
                adapter: adapter
            )
        )
    }

    // MARK: - The divergence

    func test_invokeSyncDoesNotHoldTheEngineLockWhileTheProviderRuns() {
        let router = makeRouter()
        let adapter = BlockingAdapter()
        provide(router, contractId: "bridgekit.blocking", adapter: adapter)

        DispatchQueue.global().async {
            _ = router.invokeSync(env: ["contractId": "bridgekit.blocking", "member": "slow"])
        }

        XCTAssertEqual(
            adapter.entered.wait(timeout: .now() + 3),
            .success,
            "the provider never ran"
        )

        // The provider is now executing. Another thread must still be able to use
        // the Router — this is the whole point of not holding the lock.
        let reachable = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            _ = router.isProvided(contractId: "bridgekit.unrelated", scope: .global)
            reachable.signal()
        }
        let outcome = reachable.wait(timeout: .now() + 2)

        adapter.release.signal()

        XCTAssertEqual(
            outcome,
            .success,
            "the engine lock was held across provider execution — a blocking sync provider freezes the whole Router"
        )
    }

    func test_aBlockingSyncProviderDoesNotBlockAnotherContract() {
        let router = makeRouter()
        let blocking = BlockingAdapter()
        let quick = BlockingAdapter()
        quick.release.signal()  // never actually blocks

        provide(router, contractId: "bridgekit.blocking", adapter: blocking)
        provide(router, contractId: "bridgekit.quick", adapter: quick)

        DispatchQueue.global().async {
            _ = router.invokeSync(env: ["contractId": "bridgekit.blocking", "member": "slow"])
        }
        XCTAssertEqual(blocking.entered.wait(timeout: .now() + 3), .success)

        let answered = DispatchSemaphore(value: 0)
        var envelope: [String: Any?] = [:]
        DispatchQueue.global().async {
            envelope = router.invokeSync(env: ["contractId": "bridgekit.quick", "member": "fast"])
            answered.signal()
        }
        let outcome = answered.wait(timeout: .now() + 2)

        blocking.release.signal()

        XCTAssertEqual(outcome, .success, "an unrelated contract was blocked by a slow provider")
        XCTAssertEqual(envelope["ok"] as? Bool, true)
    }

    // MARK: - Guard against regressing the working paths

    func test_invokeSyncStillReturnsTheProviderResult() {
        let router = makeRouter()
        let adapter = BlockingAdapter()
        adapter.release.signal()
        provide(router, contractId: "bridgekit.ok", adapter: adapter)

        let envelope = router.invokeSync(env: ["contractId": "bridgekit.ok", "member": "m"])

        XCTAssertEqual(envelope["ok"] as? Bool, true)
        XCTAssertEqual(envelope["value"] as? String, "done")
    }

    func test_invokeSyncReportsAnUnprovidedContract() {
        let router = makeRouter()
        let envelope = router.invokeSync(env: ["contractId": "bridgekit.missing", "member": "m"])

        XCTAssertEqual(envelope["ok"] as? Bool, false)
        XCTAssertEqual(envelope["code"] as? String, "CONTRACT_NOT_PROVIDED")
    }

    func test_invokeSyncRejectsAMissingContractId() {
        let router = makeRouter()
        let envelope = router.invokeSync(env: ["member": "m"])

        XCTAssertEqual(envelope["ok"] as? Bool, false)
        XCTAssertEqual(envelope["code"] as? String, "CONTRACT_NOT_PROVIDED")
    }
}
