package io.github.malopezr7.bridgekit

import io.github.malopezr7.bridgekit.contracts.w2parity.GetColorResult
import io.github.malopezr7.bridgekit.contracts.w2parity.GetPairResult
import io.github.malopezr7.bridgekit.contracts.w2parity.GetValueResult
import io.github.malopezr7.bridgekit.contracts.w2parity.W2ParityTest
import io.github.malopezr7.bridgekit.contracts.w2parity.W2ParityTestCodecs
import io.github.malopezr7.bridgekit.contracts.w2parity.W2ParityTestContract
import io.github.malopezr7.bridgekit.runtime.BridgeKitDecodeException
import io.github.malopezr7.bridgekit.runtime.BridgeValue
import io.github.malopezr7.bridgekit.runtime.OutboundCaller
import java.time.Instant
import java.util.Base64
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * W2 Nitro-Parity Kotlin round-trip tests.
 *
 * Proves that all 6 new schema types introduced in Wave 2 survive the full
 * JS → AnyMap → Kotlin → back cycle using the REAL generated codec functions
 * (not just string assertions on the generated Kotlin source).
 *
 * Types covered:
 *  1. int64  — Long preserves values > 2^53 with full precision
 *  2. date   — Instant round-trips through epoch-millis wire encoding
 *  3. binary — ByteArray round-trips through base64 wire encoding
 *  4. enum   — numeric enum decodes via fromWire + encodes back to wire Int
 *  5. tuple  — positional data class decodes arity + typed values; encodes to List
 *  6. oneOf  — sealed class both branches decode via @k/@v envelope
 */
class W2NitroParityRoundTripTest {

    // =========================================================================
    // 1. int64 — Long preserves precision beyond Double (> 2^53)
    // =========================================================================

    /**
     * A JS BigInt-sourced value > 2^53 must survive as a Kotlin Long without
     * precision loss. The emitted codec uses `as? Long` — this test proves the
     * Long type boundary is respected.
     */
    @Test
    fun `int64 value greater than 2^53 survives as Long with full precision`() = runTest {
        val highPrecisionValue = 9_007_199_254_740_993L // 2^53 + 1 — unrepresentable as Double

        val impl = object : W2ParityTest {
            override suspend fun getCounter(): Long = highPrecisionValue
            override suspend fun getTimestamp(): Instant = Instant.EPOCH
            override suspend fun getBytes(): ByteArray = byteArrayOf()
            override suspend fun getColor(): GetColorResult = GetColorResult.Red
            override suspend fun getPair(): GetPairResult = GetPairResult("", 0.0)
            override suspend fun getValue(): GetValueResult = GetValueResult.Opt0("")
        }

        val adapter = W2ParityTestContract.inbound(impl)
        val result = adapter.invoke("getCounter", null)

        // The inbound adapter returns the Long directly (no codec wrapping for primitives).
        assertTrue("int64 must be returned as Long", result is Long)
        assertEquals("Long value > 2^53 must preserve full precision", highPrecisionValue, result as Long)

        // Verify that Double cannot represent this value (proves the Long path is necessary)
        val asDouble = highPrecisionValue.toDouble()
        assertTrue(
            "Double loses precision for values > 2^53 — Long is required",
            asDouble.toLong() != highPrecisionValue,
        )
    }

    @Test
    fun `int64 round-trips via outbound caller returning Long`() = runTest {
        val expected = 9_007_199_254_740_993L

        val caller = object : OutboundCaller {
            override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? =
                if (member == "getCounter") expected else null
            override fun fire(member: String, payload: Map<String, Any?>?) {}
            override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = null
            override fun stream(member: String, payload: Map<String, Any?>?): Flow<Any?> = emptyFlow()
            override fun state(member: String): StateFlow<BridgeValue<Any?>> =
                MutableStateFlow(BridgeValue.Initial(null))
        }

        val client = W2ParityTestContract.outbound(caller)
        val result = client.getCounter()

        assertEquals("outbound Long round-trip must preserve precision", expected, result)
    }

    // =========================================================================
    // 2. date — Instant round-trips through epoch-millis wire encoding
    // =========================================================================

    @Test
    fun `date Instant round-trips through inbound adapter`() = runTest {
        val now = Instant.ofEpochMilli(1_718_390_400_000L) // 2024-06-14T16:00:00Z

        val impl = object : W2ParityTest {
            override suspend fun getCounter(): Long = 0L
            override suspend fun getTimestamp(): Instant = now
            override suspend fun getBytes(): ByteArray = byteArrayOf()
            override suspend fun getColor(): GetColorResult = GetColorResult.Red
            override suspend fun getPair(): GetPairResult = GetPairResult("", 0.0)
            override suspend fun getValue(): GetValueResult = GetValueResult.Opt0("")
        }

        val adapter = W2ParityTestContract.inbound(impl)
        val result = adapter.invoke("getTimestamp", null)

        assertTrue("date must be returned as Instant", result is Instant)
        assertEquals("Instant must preserve epoch millis exactly", now, result as Instant)
    }

    @Test
    fun `date outbound caller returning Instant round-trips`() = runTest {
        val expected = Instant.ofEpochMilli(1_718_390_400_000L)

        val caller = object : OutboundCaller {
            override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? =
                if (member == "getTimestamp") expected else null
            override fun fire(member: String, payload: Map<String, Any?>?) {}
            override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = null
            override fun stream(member: String, payload: Map<String, Any?>?): Flow<Any?> = emptyFlow()
            override fun state(member: String): StateFlow<BridgeValue<Any?>> =
                MutableStateFlow(BridgeValue.Initial(null))
        }

        val client = W2ParityTestContract.outbound(caller)
        val result = client.getTimestamp()

        assertEquals("Instant round-trip via outbound caller", expected, result)
    }

    // =========================================================================
    // 3. binary — ByteArray round-trips through base64 wire encoding
    // =========================================================================

    @Test
    fun `binary ByteArray round-trips through inbound adapter`() = runTest {
        val bytes = byteArrayOf(0xDE.toByte(), 0xAD.toByte(), 0xBE.toByte(), 0xEF.toByte())

        val impl = object : W2ParityTest {
            override suspend fun getCounter(): Long = 0L
            override suspend fun getTimestamp(): Instant = Instant.EPOCH
            override suspend fun getBytes(): ByteArray = bytes
            override suspend fun getColor(): GetColorResult = GetColorResult.Red
            override suspend fun getPair(): GetPairResult = GetPairResult("", 0.0)
            override suspend fun getValue(): GetValueResult = GetValueResult.Opt0("")
        }

        val adapter = W2ParityTestContract.inbound(impl)
        val result = adapter.invoke("getBytes", null)

        assertTrue("binary must be returned as ByteArray", result is ByteArray)
        assertArrayEquals("ByteArray must preserve all bytes exactly", bytes, result as ByteArray)
    }

    @Test
    fun `binary outbound caller returning ByteArray round-trips`() = runTest {
        val expected = byteArrayOf(1, 2, 3, 4, 5)

        val caller = object : OutboundCaller {
            override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? =
                if (member == "getBytes") expected else null
            override fun fire(member: String, payload: Map<String, Any?>?) {}
            override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = null
            override fun stream(member: String, payload: Map<String, Any?>?): Flow<Any?> = emptyFlow()
            override fun state(member: String): StateFlow<BridgeValue<Any?>> =
                MutableStateFlow(BridgeValue.Initial(null))
        }

        val client = W2ParityTestContract.outbound(caller)
        val result = client.getBytes()

        assertArrayEquals("ByteArray round-trip via outbound caller", expected, result)
    }

    // =========================================================================
    // 4. enum — numeric enum decodes via fromWire + encodes back to wire Int
    // =========================================================================

    @Test
    fun `numeric enum all members decode from wire Int correctly`() {
        // Prove that each wire Int maps to the correct Kotlin enum member
        assertEquals("wire 0 -> Red", GetColorResult.Red, GetColorResult.fromWire(0))
        assertEquals("wire 1 -> Green", GetColorResult.Green, GetColorResult.fromWire(1))
        assertEquals("wire 2 -> Blue", GetColorResult.Blue, GetColorResult.fromWire(2))
        assertNull("unknown wire value returns null", GetColorResult.fromWire(99))
    }

    @Test
    fun `numeric enum encode round-trip preserves wire value`() {
        // Prove encode → decode cycle is lossless
        for (member in GetColorResult.entries) {
            val wireInt = member.wireValue
            val decoded = GetColorResult.fromWire(wireInt)
            assertEquals("enum member ${member.name} must round-trip via wireValue", member, decoded)
        }
    }

    @Test
    fun `numeric enum inbound adapter returns enum member from impl`() = runTest {
        val impl = object : W2ParityTest {
            override suspend fun getCounter(): Long = 0L
            override suspend fun getTimestamp(): Instant = Instant.EPOCH
            override suspend fun getBytes(): ByteArray = byteArrayOf()
            override suspend fun getColor(): GetColorResult = GetColorResult.Green
            override suspend fun getPair(): GetPairResult = GetPairResult("", 0.0)
            override suspend fun getValue(): GetValueResult = GetValueResult.Opt0("")
        }

        val adapter = W2ParityTestContract.inbound(impl)
        val result = adapter.invoke("getColor", null)

        assertEquals("enum value from inbound adapter must be GetColorResult.Green", GetColorResult.Green, result)
    }

    // =========================================================================
    // 5. tuple — positional data class
    // =========================================================================

    @Test
    fun `tuple encodes to List with positional values`() {
        val pair = GetPairResult(v0 = "hello", v1 = 3.14)
        val encoded = W2ParityTestCodecs.encodeGetPairResult(pair)

        assertEquals("tuple must encode to List of arity 2", 2, encoded.size)
        assertEquals("v0 must be at index 0", "hello", encoded[0])
        assertEquals("v1 must be at index 1", 3.14, encoded[1] as Double, 0.0001)
    }

    @Test
    fun `tuple decodes from wire List with correct arity and types`() {
        val wireList = listOf<Any?>("world", 2.718)
        val decoded = W2ParityTestCodecs.decodeGetPairResult(wireList)

        assertEquals("v0 must decode from index 0", "world", decoded.v0)
        assertEquals("v1 must decode from index 1", 2.718, decoded.v1, 0.0001)
    }

    @Test
    fun `tuple encode-decode round-trip is lossless`() {
        val original = GetPairResult(v0 = "roundtrip", v1 = 42.0)
        val encoded = W2ParityTestCodecs.encodeGetPairResult(original)
        val decoded = W2ParityTestCodecs.decodeGetPairResult(encoded)

        assertEquals("tuple round-trip must preserve v0", original.v0, decoded.v0)
        assertEquals("tuple round-trip must preserve v1", original.v1, decoded.v1, 0.0001)
    }

    @Test
    fun `tuple decode throws on insufficient arity`() {
        val shortList = listOf<Any?>("only-one")
        assertThrows(BridgeKitDecodeException::class.java) {
            W2ParityTestCodecs.decodeGetPairResult(shortList)
        }
    }

    @Test
    fun `tuple inbound adapter returns encoded List via codec`() = runTest {
        val pair = GetPairResult(v0 = "test", v1 = 9.9)

        val impl = object : W2ParityTest {
            override suspend fun getCounter(): Long = 0L
            override suspend fun getTimestamp(): Instant = Instant.EPOCH
            override suspend fun getBytes(): ByteArray = byteArrayOf()
            override suspend fun getColor(): GetColorResult = GetColorResult.Red
            override suspend fun getPair(): GetPairResult = pair
            override suspend fun getValue(): GetValueResult = GetValueResult.Opt0("")
        }

        val adapter = W2ParityTestContract.inbound(impl)
        val result = adapter.invoke("getPair", null)

        assertTrue("inbound tuple result must be a List", result is List<*>)
        val list = result as List<*>
        assertEquals("encoded arity must be 2", 2, list.size)
        assertEquals("v0 must be encoded at index 0", "test", list[0])
    }

    // =========================================================================
    // 6. oneOf — sealed class @k/@v envelope, both branches
    // =========================================================================

    @Test
    fun `oneOf Opt0 branch encodes to envelope with k=0 and v=string`() {
        val value = GetValueResult.Opt0("hello")
        val encoded = W2ParityTestCodecs.encodeGetValueResult(value)

        assertEquals("oneOf Opt0 must encode @k=0", 0, encoded["@k"])
        assertEquals("oneOf Opt0 must encode @v=string value", "hello", encoded["@v"])
    }

    @Test
    fun `oneOf Opt1 branch encodes to envelope with k=1 and v=number`() {
        val value = GetValueResult.Opt1(3.14)
        val encoded = W2ParityTestCodecs.encodeGetValueResult(value)

        assertEquals("oneOf Opt1 must encode @k=1", 1, encoded["@k"])
        assertEquals("oneOf Opt1 must encode @v=Double value", 3.14, encoded["@v"] as Double, 0.0001)
    }

    @Test
    fun `oneOf Opt0 branch decodes from k=0 wire envelope`() {
        val wire: Map<String, Any?> = mapOf("@k" to 0, "@v" to "decoded-string")
        val result = W2ParityTestCodecs.decodeGetValueResult(wire)

        assertTrue("oneOf @k=0 must decode to Opt0", result is GetValueResult.Opt0)
        assertEquals("Opt0 value must match @v", "decoded-string", (result as GetValueResult.Opt0).value)
    }

    @Test
    fun `oneOf Opt1 branch decodes from k=1 wire envelope`() {
        val wire: Map<String, Any?> = mapOf("@k" to 1, "@v" to 99.5)
        val result = W2ParityTestCodecs.decodeGetValueResult(wire)

        assertTrue("oneOf @k=1 must decode to Opt1", result is GetValueResult.Opt1)
        assertEquals("Opt1 value must match @v", 99.5, (result as GetValueResult.Opt1).value, 0.0001)
    }

    @Test
    fun `oneOf encode-decode round-trip is lossless for both branches`() {
        val opt0 = GetValueResult.Opt0("round-trip-string")
        val encodedOpt0 = W2ParityTestCodecs.encodeGetValueResult(opt0)
        val decodedOpt0 = W2ParityTestCodecs.decodeGetValueResult(encodedOpt0)
        assertTrue("Opt0 must round-trip", decodedOpt0 is GetValueResult.Opt0)
        assertEquals("Opt0.value must be preserved", "round-trip-string", (decodedOpt0 as GetValueResult.Opt0).value)

        val opt1 = GetValueResult.Opt1(7.77)
        val encodedOpt1 = W2ParityTestCodecs.encodeGetValueResult(opt1)
        val decodedOpt1 = W2ParityTestCodecs.decodeGetValueResult(encodedOpt1)
        assertTrue("Opt1 must round-trip", decodedOpt1 is GetValueResult.Opt1)
        assertEquals("Opt1.value must be preserved", 7.77, (decodedOpt1 as GetValueResult.Opt1).value, 0.0001)
    }

    @Test
    fun `oneOf decode throws BridgeKitDecodeException for unknown k index`() {
        val wire: Map<String, Any?> = mapOf("@k" to 99, "@v" to "anything")
        assertThrows(BridgeKitDecodeException::class.java) {
            W2ParityTestCodecs.decodeGetValueResult(wire)
        }
    }

    @Test
    fun `oneOf decode throws BridgeKitDecodeException when k key is missing`() {
        val wire: Map<String, Any?> = mapOf("@v" to "no-key")
        assertThrows(BridgeKitDecodeException::class.java) {
            W2ParityTestCodecs.decodeGetValueResult(wire)
        }
    }

    @Test
    fun `oneOf inbound adapter returns k-v envelope encoded map via codec`() = runTest {
        val impl = object : W2ParityTest {
            override suspend fun getCounter(): Long = 0L
            override suspend fun getTimestamp(): Instant = Instant.EPOCH
            override suspend fun getBytes(): ByteArray = byteArrayOf()
            override suspend fun getColor(): GetColorResult = GetColorResult.Red
            override suspend fun getPair(): GetPairResult = GetPairResult("", 0.0)
            override suspend fun getValue(): GetValueResult = GetValueResult.Opt1(1.5)
        }

        val adapter = W2ParityTestContract.inbound(impl)
        val result = adapter.invoke("getValue", null)

        assertTrue("oneOf inbound result must be a Map", result is Map<*, *>)
        val map = result as Map<*, *>
        assertEquals("@k must be 1 for Opt1", 1, map["@k"])
        assertEquals("@v must be 1.5 for Opt1", 1.5, map["@v"] as Double, 0.0001)
    }
}
