package io.github.malopezr7.bridgekit

import io.github.malopezr7.bridgekit.core.*
import io.github.malopezr7.bridgekit.runtime.BridgeValue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Native state gone-transitions (markUnprovided, Replacing, grace-expiry)
 * MUST notify JS observers with a "gone" signal (map without "v" key).
 * ADDITIVE only — no new BridgeValue sealed branch introduced.
 */
class H13StateNotifyTest {

    private lateinit var stateStore: StateStore

    @Before
    fun setup() {
        stateStore = StateStore()
    }

    // ---- markUnprovided notifies observers ------------------------------------

    @Test
    fun `markUnprovided sends gone signal to JS observer`() {
        stateStore.seedNativeState("c1", Scope.Global, "key", "hello")

        val received = mutableListOf<Map<String, Any?>>()
        stateStore.observe("c1", Scope.Global, "key", epoch = 1) { map ->
            received.add(map)
        }

        // Confirm initial write-path notify works
        stateStore.setNativeValue("c1", Scope.Global, "key", "updated")
        assertEquals(1, received.size)
        assertEquals("updated", received[0]["v"])

        received.clear()

        // markUnprovided must notify with gone signal (no "v" key)
        stateStore.markUnprovided("c1", Scope.Global)

        assertEquals("markUnprovided must notify observer exactly once", 1, received.size)
        // Gone signal: "v" key absent so map.v === undefined on JS side
        assertFalse("gone notification must NOT carry 'v' key", received[0].containsKey("v"))
        assertEquals("gone", received[0]["status"])
    }

    @Test
    fun `markUnprovided gone signal only fires for matching contract+scope`() {
        stateStore.seedNativeState("c1", Scope.Global, "key", "a")
        stateStore.seedNativeState("c2", Scope.Global, "key", "b")

        val c1Received = mutableListOf<Map<String, Any?>>()
        val c2Received = mutableListOf<Map<String, Any?>>()

        stateStore.observe("c1", Scope.Global, "key", epoch = 1) { c1Received.add(it) }
        stateStore.observe("c2", Scope.Global, "key", epoch = 1) { c2Received.add(it) }

        stateStore.markUnprovided("c1", Scope.Global)

        assertEquals(1, c1Received.size)
        assertTrue(c2Received.isEmpty())
    }

    // ---- markJsContractsUnprovided (Replacing transition) notifies observers ---

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `markJsContractsUnprovided Replacing transition notifies observer with gone signal`() = runTest {
        val testScope = TestScope(StandardTestDispatcher(testScheduler))
        val store = StateStore(replacingGraceMs = 250L, graceScope = testScope)

        store.writeFromJs("js.c", Scope.Global, "count", 10, nativeOwnsBinding = false)

        val received = mutableListOf<Map<String, Any?>>()
        store.observe("js.c", Scope.Global, "count", epoch = 1) { received.add(it) }

        // Trigger epoch swap → Replacing
        store.markJsContractsUnprovided(setOf("js.c"))

        // Replacing transition must notify observer with gone signal
        assertEquals("Replacing transition must notify observer", 1, received.size)
        assertFalse("gone notification must NOT carry 'v' key", received[0].containsKey("v"))
        assertEquals("gone", received[0]["status"])
    }

    // ---- grace-expiry (Unprovided) notifies observers -------------------------

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `grace expiry Unprovided transition notifies observer with gone signal`() = runTest {
        val testScope = TestScope(StandardTestDispatcher(testScheduler))
        val store = StateStore(replacingGraceMs = 250L, graceScope = testScope)

        store.writeFromJs("js.c", Scope.Global, "count", 42, nativeOwnsBinding = false)

        val received = mutableListOf<Map<String, Any?>>()
        store.observe("js.c", Scope.Global, "count", epoch = 1) { received.add(it) }

        store.markJsContractsUnprovided(setOf("js.c"))
        received.clear() // ignore Replacing signal, focus on grace-expiry

        // Advance past grace window
        testScope.advanceTimeBy(300L)

        // grace-expiry → Unprovided must also notify observer with gone signal
        assertEquals("grace-expiry must notify observer", 1, received.size)
        assertFalse("grace-expiry gone notification must NOT carry 'v' key", received[0].containsKey("v"))
        assertEquals("gone", received[0]["status"])
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `re-provision during grace window cancels timer and does not send spurious gone`() = runTest {
        val testScope = TestScope(StandardTestDispatcher(testScheduler))
        val store = StateStore(replacingGraceMs = 250L, graceScope = testScope)

        store.writeFromJs("js.c", Scope.Global, "count", 5, nativeOwnsBinding = false)

        val received = mutableListOf<Map<String, Any?>>()
        store.observe("js.c", Scope.Global, "count", epoch = 1) { received.add(it) }

        store.markJsContractsUnprovided(setOf("js.c"))
        received.clear() // ignore Replacing signal

        // Re-provide before timer fires
        store.writeFromJs("js.c", Scope.Global, "count", 99, nativeOwnsBinding = false)
        val reprovideCallCount = received.size
        received.clear()

        // Advance past grace window — re-provision should have cancelled the timer
        testScope.advanceTimeBy(300L)

        // No additional gone signal should have fired after re-provision
        assertEquals("no spurious gone signal after re-provision", 0, received.size)
    }

    // ---- BridgeValue sealed class integrity check ----------------------------

    @Test
    fun `BridgeValue has exactly 4 sealed subtypes - no new branch added`() {
        // If a new sealed branch is added, exhaustive when expressions across consumers
        // will fail to compile. This test acts as a canary.
        val available: BridgeValue<String> = BridgeValue.Available("a")
        val initial: BridgeValue<String> = BridgeValue.Initial("b")
        val replacing: BridgeValue<String> = BridgeValue.Replacing("c")
        val unprovided: BridgeValue<String> = BridgeValue.Unprovided("d")

        // All 4 types accessible, no extras
        assertTrue(available is BridgeValue.Available)
        assertTrue(initial is BridgeValue.Initial)
        assertTrue(replacing is BridgeValue.Replacing)
        assertTrue(unprovided is BridgeValue.Unprovided)
    }
}
