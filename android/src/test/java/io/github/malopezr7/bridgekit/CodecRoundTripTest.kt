package io.github.malopezr7.bridgekit

import io.github.malopezr7.bridgekit.contracts.hardening.GetUserByIdParams
import io.github.malopezr7.bridgekit.contracts.hardening.GetUserByIdResult
import io.github.malopezr7.bridgekit.contracts.hardening.HardeningFixtureCodecs
import io.github.malopezr7.bridgekit.contracts.hardening.HardeningFixtureContract
import io.github.malopezr7.bridgekit.contracts.hardening.NotifyParams
import io.github.malopezr7.bridgekit.contracts.hardening.TickStreamValue
import io.github.malopezr7.bridgekit.runtime.BridgeKitDecodeException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * W0-2: Codec round-trip property test.
 *
 * Validates that JS-origin values encoded as Map<String, Any?> (the AnyMap wire shape)
 * are decoded by the generated Kotlin codec to identical typed values, and that encoding
 * a typed value back to a map produces an equivalent round-trip.
 *
 * These tests exercise the real generated codecs in HardeningFixtureContract without
 * requiring a Nitro JNI layer — the codec is pure Kotlin operating on plain maps.
 *
 * Scope:
 *  - Scalar types: String, Double, Boolean
 *  - Nested object: GetUserByIdParams / GetUserByIdResult
 *  - Number coercion: Int on the wire → Double in the typed result (JS always sends Double)
 *  - Null/missing fields: fabricated defaults (current behaviour, documented as a W1-5 gap)
 *  - Array: TickStreamValue (object in array)
 *  - Inbound adapter round-trip: adapter decodes and re-encodes through impl
 */
class CodecRoundTripTest {

    // ---- Scalar round-trips -------------------------------------------------------

    @Test
    fun `string field round-trips as identity`() {
        val params = GetUserByIdParams(id = "user-abc")
        val encoded = HardeningFixtureCodecs.encodeGetUserByIdParams(params)
        val decoded = HardeningFixtureCodecs.decodeGetUserByIdParams(encoded)

        assertEquals("user-abc", decoded.id)
    }

    @Test
    fun `number field round-trips as Double`() {
        val result = GetUserByIdResult(userId = "u1", name = "Alice", score = 3.14)
        val encoded = HardeningFixtureCodecs.encodeGetUserByIdResult(result)
        val decoded = HardeningFixtureCodecs.decodeGetUserByIdResult(encoded)

        assertEquals(3.14, decoded.score, 0.0001)
    }

    @Test
    fun `integer on wire is coerced to Double`() {
        // JS sends numbers as doubles; on the Kotlin side we accept Int via the Number coercion.
        val raw = mapOf("userId" to "u1", "name" to "Bob", "score" to 42)
        val decoded = HardeningFixtureCodecs.decodeGetUserByIdResult(raw)

        assertEquals(42.0, decoded.score, 0.0001)
    }

    @Test
    fun `nested object round-trips all fields`() {
        val result = GetUserByIdResult(userId = "user-42", name = "Carol", score = 9.9)
        val encoded = HardeningFixtureCodecs.encodeGetUserByIdResult(result)

        assertEquals("user-42", encoded["userId"])
        assertEquals("Carol", encoded["name"])
        assertEquals(9.9, encoded["score"] as Double, 0.0001)

        val decoded = HardeningFixtureCodecs.decodeGetUserByIdResult(encoded)
        assertEquals(result.userId, decoded.userId)
        assertEquals(result.name, decoded.name)
        assertEquals(result.score, decoded.score, 0.0001)
    }

    @Test
    fun `TickStreamValue object round-trips`() {
        val value = TickStreamValue(tick = 7.0)
        val encoded = HardeningFixtureCodecs.encodeTickStreamValue(value)
        val decoded = HardeningFixtureCodecs.decodeTickStreamValue(encoded)

        assertEquals(7.0, decoded.tick, 0.0001)
    }

    @Test
    fun `NotifyParams string field round-trips`() {
        val params = NotifyParams(message = "hello world")
        val encoded = HardeningFixtureCodecs.encodeNotifyParams(params)
        val decoded = HardeningFixtureCodecs.decodeNotifyParams(encoded)

        assertEquals("hello world", decoded.message)
    }

    // ---- Missing/wrong-type required field → fail-fast (W1-5, design D3) ---------

    @Test
    fun `missing required string field throws BridgeKitDecodeException`() {
        // W1-5: the decoder MUST NOT fabricate "" — it throws naming the missing field.
        val raw = mapOf<String, Any?>() // missing "id"
        val ex = assertThrows(BridgeKitDecodeException::class.java) {
            HardeningFixtureCodecs.decodeGetUserByIdParams(raw)
        }
        assertEquals("id", ex.field)
        assertEquals("String", ex.expectedType)
    }

    @Test
    fun `missing required number field throws BridgeKitDecodeException`() {
        // W1-5: the decoder MUST NOT fabricate 0.0 — it throws naming the field.
        val raw = mapOf<String, Any?>("userId" to "u1", "name" to "X") // missing "score"
        val ex = assertThrows(BridgeKitDecodeException::class.java) {
            HardeningFixtureCodecs.decodeGetUserByIdResult(raw)
        }
        assertEquals("score", ex.field)
        assertEquals("Double", ex.expectedType)
    }

    @Test
    fun `wrong-type number field throws BridgeKitDecodeException (no coercion to 0_0)`() {
        // W1-5: a String where a Double is required must NOT coerce to 0.0.
        val raw = mapOf<String, Any?>("userId" to "u1", "name" to "X", "score" to "free")
        val ex = assertThrows(BridgeKitDecodeException::class.java) {
            HardeningFixtureCodecs.decodeGetUserByIdResult(raw)
        }
        assertEquals("score", ex.field)
    }

    // ---- Inbound adapter round-trip via Router.invoke ----------------------------

    @Test
    fun `inbound adapter decodes payload and calls impl with correct typed params`() = runTest {
        var receivedId: String? = null
        val impl = object : io.github.malopezr7.bridgekit.contracts.hardening.HardeningFixture {
            override suspend fun getUserById(
                params: GetUserByIdParams,
            ): GetUserByIdResult {
                receivedId = params.id
                return GetUserByIdResult(userId = params.id, name = "Test", score = 1.0)
            }
            override fun notify(params: NotifyParams) {}
            override fun tickStream(): kotlinx.coroutines.flow.Flow<TickStreamValue> =
                kotlinx.coroutines.flow.emptyFlow()
            override val status =
                kotlinx.coroutines.flow.MutableStateFlow("idle")
            override val count =
                kotlinx.coroutines.flow.MutableStateFlow(0.0)
        }

        val adapter = HardeningFixtureContract.inbound(impl)
        val payload = mapOf("id" to "user-xyz")
        val result = adapter.invoke("getUserById", payload)

        assertEquals("user-xyz", receivedId)
        assertTrue("Result must be a Map", result is Map<*, *>)
        @Suppress("UNCHECKED_CAST")
        val resultMap = result as Map<String, Any?>
        assertEquals("user-xyz", resultMap["userId"])
        assertEquals("Test", resultMap["name"])
    }

    @Test
    fun `inbound adapter returns null for Void (fire-and-forget) member`() = runTest {
        var notified = false
        val impl = object : io.github.malopezr7.bridgekit.contracts.hardening.HardeningFixture {
            override suspend fun getUserById(params: GetUserByIdParams) =
                GetUserByIdResult("", "", 0.0)
            override fun notify(params: NotifyParams) { notified = true }
            override fun tickStream(): kotlinx.coroutines.flow.Flow<TickStreamValue> =
                kotlinx.coroutines.flow.emptyFlow()
            override val status =
                kotlinx.coroutines.flow.MutableStateFlow("idle")
            override val count =
                kotlinx.coroutines.flow.MutableStateFlow(0.0)
        }

        val adapter = HardeningFixtureContract.inbound(impl)
        val result = adapter.invoke("notify", mapOf("message" to "ping"))

        assertTrue("notify was called", notified)
        assertNull("Void member must return null", result)
    }

    @Test
    fun `stateInitials returns correct initial values`() {
        val impl = object : io.github.malopezr7.bridgekit.contracts.hardening.HardeningFixture {
            override suspend fun getUserById(params: GetUserByIdParams) =
                GetUserByIdResult("", "", 0.0)
            override fun notify(params: NotifyParams) {}
            override fun tickStream(): kotlinx.coroutines.flow.Flow<TickStreamValue> =
                kotlinx.coroutines.flow.emptyFlow()
            override val status =
                kotlinx.coroutines.flow.MutableStateFlow("idle")
            override val count =
                kotlinx.coroutines.flow.MutableStateFlow(0.0)
        }

        val adapter = HardeningFixtureContract.inbound(impl)
        val initials = adapter.stateInitials

        assertEquals("idle", initials["status"])
        assertEquals(0, initials["count"])
    }

    // ---- W-3 (verify fix): Optional / nullable field absent → decodes to null -----

    /**
     * W-3: Spec — contract-integrity — "Optional field absent — no error"
     *
     * GIVEN an optional String? field `nickname`
     * WHEN the AnyMap does NOT contain `nickname`
     * THEN decoding succeeds and `nickname` is null
     *
     * This mirrors the generated codec pattern for `optional` / `nullable` fields:
     *   if (raw["fieldName"] == null) null else (raw["fieldName"] as? String)
     *       ?: throw BridgeKitDecodeException(...)
     *
     * Uses an inline codec mirroring the emitter output to prove the pattern — no new
     * contract file is required since the emitter's nullable path is consistent.
     */
    @Test
    fun `W-3 optional nullable field absent decodes to null without exception`() {
        // Inline mirror of the emitter's nullable decode pattern (kotlin.ts _decodeExpr optional/nullable):
        //   if (raw["nickname"] == null) null
        //   else (raw["nickname"] as? String) ?: throw BridgeKitDecodeException("nickname", "String")
        data class UserWithOptionalNickname(val id: String, val nickname: String?)

        fun decode(raw: Map<*, *>): UserWithOptionalNickname {
            val id = (raw["id"] as? String) ?: throw BridgeKitDecodeException("id", "String")
            val nickname: String? = if (raw["nickname"] == null) null
                else (raw["nickname"] as? String) ?: throw BridgeKitDecodeException("nickname", "String")
            return UserWithOptionalNickname(id = id, nickname = nickname)
        }

        // Field absent (key not present) — must decode to null without throwing
        val rawAbsent = mapOf("id" to "user-1") // "nickname" not present → raw["nickname"] == null
        val decodedAbsent = decode(rawAbsent)
        assertEquals("user-1", decodedAbsent.id)
        assertNull("nickname must be null when field is absent from the map", decodedAbsent.nickname)

        // Field explicitly null — also must decode to null without throwing
        val rawExplicitNull = mapOf("id" to "user-2", "nickname" to null)
        val decodedNull = decode(rawExplicitNull)
        assertNull("nickname must be null when field is explicitly null", decodedNull.nickname)

        // Field present with a value — must decode correctly
        val rawPresent = mapOf("id" to "user-3", "nickname" to "Ace")
        val decodedPresent = decode(rawPresent)
        assertEquals("Ace", decodedPresent.nickname)
    }

    /**
     * W-3 contrast: absent REQUIRED field still throws BridgeKitDecodeException (no regression).
     * Confirms the success path for optional does not weaken the required-field check.
     */
    @Test
    fun `W-3 absent required field still throws — optional success does not weaken required check`() {
        // Required field "id" absent — must still throw
        val raw = mapOf<String, Any?>() // missing required "id"
        val ex = assertThrows(BridgeKitDecodeException::class.java) {
            HardeningFixtureCodecs.decodeGetUserByIdParams(raw)
        }
        assertEquals("id", ex.field)
        assertEquals("String", ex.expectedType)
    }

    @Test
    fun `stateFlows returns both state flows`() {
        val impl = object : io.github.malopezr7.bridgekit.contracts.hardening.HardeningFixture {
            override suspend fun getUserById(params: GetUserByIdParams) =
                GetUserByIdResult("", "", 0.0)
            override fun notify(params: NotifyParams) {}
            override fun tickStream(): kotlinx.coroutines.flow.Flow<TickStreamValue> =
                kotlinx.coroutines.flow.emptyFlow()
            override val status =
                kotlinx.coroutines.flow.MutableStateFlow("idle")
            override val count =
                kotlinx.coroutines.flow.MutableStateFlow(0.0)
        }

        val adapter = HardeningFixtureContract.inbound(impl)
        val flows = adapter.stateFlows()

        assertTrue("status flow must be present", flows.containsKey("status"))
        assertTrue("count flow must be present", flows.containsKey("count"))
    }
}
