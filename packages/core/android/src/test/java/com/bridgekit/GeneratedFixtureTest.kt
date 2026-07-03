package com.bridgekit

import com.bridgekit.contracts.connect.host.*
import com.bridgekit.core.*
import com.bridgekit.runtime.BridgeValue
import com.bridgekit.runtime.OutboundCaller
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Before
import org.junit.Ignore
import org.junit.Test

/**
 * Integration check: the CLI-generated ConnectHostContract must compile and wire correctly
 * with the runtime types in this module.
 *
 * Tests:
 *  1. inbound(impl).invoke round trip
 *  2. outbound(caller) proxy round trip
 *  3. Generated fixture compiles at all (compile-time check)
 */
class GeneratedFixtureTest {

    private lateinit var router: Router
    private lateinit var bridgeKit: BridgeKit

    @Before
    fun setup() {
        router = Router(StateStore(), ParkBuffer(), readinessTimeoutMs = 500, callTimeoutMs = 2000)
        bridgeKit = BridgeKit(router)
    }

    // ---- inbound adapter round trip -------------------------------------------

    @Test
    fun `inbound adapter routes isLoggedIn to impl`() = runTest {
        val impl = FakeConnectHostImpl(loggedIn = true)
        val adapter = ConnectHostContract.inbound(impl)

        val result = adapter.invoke("isLoggedIn", null)
        assertEquals(true, result)
    }

    @Test
    fun `inbound adapter routes showLogin (fire-and-forget)`() = runTest {
        val impl = FakeConnectHostImpl()
        val adapter = ConnectHostContract.inbound(impl)

        val result = adapter.invoke("showLogin", null)
        assertNull(result)
        assertTrue(impl.showLoginCalled)
    }

    @Test
    fun `inbound adapter routes installEsim with params`() = runTest {
        val impl = FakeConnectHostImpl(esimResult = InstallEsimResult.SUCCESS)
        val adapter = ConnectHostContract.inbound(impl)

        val payload = mapOf("url" to "esim://test", "iccId" to "1234")
        val result = adapter.invoke("installEsim", payload)

        assertEquals(InstallEsimResult.SUCCESS, result)
        assertEquals("esim://test", impl.lastEsimUrl)
        assertEquals("1234", impl.lastEsimIccId)
    }

    @Test
    fun `inbound adapter encodes object result — getDeviceInfo returns map not data class`() = runTest {
        // Regression for Bug 1: inbound adapter was calling impl.getDeviceInfo() raw
        // (returning GetDeviceInfoResult data class) instead of encoding it through the codec.
        // The bridge can only carry plain maps across the AnyMap boundary; data classes are
        // incompatible. After the fix the adapter must return Map<String, Any?>.
        val impl = FakeConnectHostImpl()
        val adapter = ConnectHostContract.inbound(impl)

        val result = adapter.invoke("getDeviceInfo", null)
        assertTrue("Expected Map<*, *> but got ${result?.javaClass}", result is Map<*, *>)
        val map = result as Map<*, *>
        assertEquals("TestPhone", map["model"])
        assertEquals("15.0", map["osVersion"])
    }

    @Test
    fun `inbound invokeSync encodes object result — getDeviceInfo returns map not data class`() {
        // Regression for Bug 1: the invoke_sync secondary path had the same missing-encode bug.
        val impl = FakeConnectHostImpl()
        val adapter = ConnectHostContract.inbound(impl)

        val result = adapter.invokeSync("getDeviceInfo", null)
        assertTrue("Expected Map<*, *> but got ${result?.javaClass}", result is Map<*, *>)
        val map = result as Map<*, *>
        assertEquals("TestPhone", map["model"])
        assertEquals("15.0", map["osVersion"])
    }

    @Test
    fun `inbound adapter returns stateInitials for connectivity`() {
        val impl = FakeConnectHostImpl()
        val adapter = ConnectHostContract.inbound(impl)
        val initials = adapter.stateInitials

        assertTrue(initials.containsKey("connectivity"))
        val connMap = initials["connectivity"]
        assertTrue(connMap is Map<*, *>)
        assertEquals(false, (connMap as Map<*, *>)["online"])
    }

    @Test
    fun `inbound adapter openStream returns otpCodes flow`() = runTest {
        val impl = FakeConnectHostImpl()
        val adapter = ConnectHostContract.inbound(impl)

        val flow = adapter.openStream("otpCodes", null)
        assertNotNull(flow)
    }

    @Test
    fun `inbound adapter stateFlows returns connectivity stateFlow`() {
        val impl = FakeConnectHostImpl()
        val adapter = ConnectHostContract.inbound(impl)
        val flows = adapter.stateFlows()

        assertTrue(flows.containsKey("connectivity"))
    }

    @Test
    fun `inbound adapter throws on unknown member`() = runTest {
        val impl = FakeConnectHostImpl()
        val adapter = ConnectHostContract.inbound(impl)

        var thrown = false
        try {
            adapter.invoke("nonExistentMember", null)
        } catch (e: IllegalArgumentException) {
            thrown = true
        }
        assertTrue("Expected IllegalArgumentException for unknown member", thrown)
    }

    // ---- outbound proxy round trip -------------------------------------------

    @Test
    fun `outbound proxy isLoggedIn suspends and returns value`() = runTest {
        val callerResult = true
        val caller = FakeOutboundCaller(invokeResult = callerResult)
        val proxy = ConnectHostContract.outbound(caller)

        val result = proxy.isLoggedIn()
        assertEquals(true, result)
        assertEquals("isLoggedIn", caller.lastInvokedMember)
    }

    @Test
    fun `outbound proxy showLogin calls invokeSync`() {
        val caller = FakeOutboundCaller()
        val proxy = ConnectHostContract.outbound(caller)

        proxy.showLogin()
        assertEquals("showLogin", caller.lastSyncMember)
    }

    @Test
    fun `outbound proxy connectivity returns StateFlow of BridgeValue`() {
        val caller = FakeOutboundCaller()
        val proxy = ConnectHostContract.outbound(caller)

        val stateFlow = proxy.connectivity
        assertNotNull(stateFlow)
        assertEquals("connectivity", caller.lastStateKey)
    }

    @Test
    fun `outbound proxy otpCodes returns Flow`() {
        val caller = FakeOutboundCaller()
        val proxy = ConnectHostContract.outbound(caller)

        val flow = proxy.otpCodes()
        assertNotNull(flow)
        assertEquals("otpCodes", caller.lastStreamMember)
    }

    // ---- full router round trip -----------------------------------------------

    @Ignore(
        "QUARANTINED(WS-5): timing-sensitive under slow CI runners; " +
            "StreamHub races tracked as RT-AND-03/RT-AND-04 - un-ignore when WS-5 fixes the hub"
    )
    @Test
    fun `provide and router-level invoke works end-to-end`() = runTest {
        val impl = FakeConnectHostImpl(loggedIn = true)
        bridgeKit.provide(ConnectHostContract, Scope.Global) { impl }

        val env = mapOf(
            "contractId" to "connect.host",
            "member" to "isLoggedIn",
            "scope" to mapOf("kind" to "global"),
            "correlationId" to "test-corr",
            "epoch" to 1,
        )
        var result: Map<String, Any?>? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        router.invoke(env) { r ->
            result = r
            latch.countDown()
        }
        assertTrue(latch.await(3, java.util.concurrent.TimeUnit.SECONDS))
        assertNotNull(result)
        assertEquals(true, result!!["ok"])
        assertEquals(true, result!!["value"])
    }
}

// ---- FakeConnectHostImpl ---------------------------------------------------

private class FakeConnectHostImpl(
    private val loggedIn: Boolean = false,
    private val esimResult: InstallEsimResult = InstallEsimResult.SUCCESS,
) : ConnectHost {
    var showLoginCalled = false
    var lastEsimUrl: String? = null
    var lastEsimIccId: String? = null

    override fun showLogin() { showLoginCalled = true }

    override suspend fun isLoggedIn(): Boolean = loggedIn

    override suspend fun installEsim(params: InstallEsimParams): InstallEsimResult {
        lastEsimUrl = params.url
        lastEsimIccId = params.iccId
        return esimResult
    }

    override fun getDeviceInfo(): GetDeviceInfoResult = GetDeviceInfoResult("TestPhone", "15.0")

    override suspend fun pickMedia(params: PickMediaParams): PickMediaResult? = null

    override fun trackEvent(params: TrackEventParams) {}

    override fun otpCodes(): Flow<String> = flowOf("123456")

    override val connectivity = MutableStateFlow(Connectivity(online = true))
}

// ---- FakeOutboundCaller ---------------------------------------------------

private class FakeOutboundCaller(
    private val invokeResult: Any? = null,
) : OutboundCaller {
    var lastInvokedMember: String? = null
    var lastSyncMember: String? = null
    var lastStreamMember: String? = null
    var lastStateKey: String? = null

    var lastFiredMember: String? = null

    override fun fire(member: String, payload: Map<String, Any?>?) {
        lastFiredMember = member
    }

    override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? {
        lastInvokedMember = member
        return invokeResult
    }

    override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? {
        lastSyncMember = member
        return null
    }

    override fun stream(member: String, payload: Map<String, Any?>?): Flow<Any?> {
        lastStreamMember = member
        return emptyFlow()
    }

    override fun state(member: String): StateFlow<BridgeValue<Any?>> {
        lastStateKey = member
        return MutableStateFlow(BridgeValue.Initial(null))
    }
}
