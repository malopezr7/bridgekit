package io.github.malopezr7.bridgekit

import io.github.malopezr7.bridgekit.core.Scope
import org.junit.Assert.*
import org.junit.Test

class ScopeTest {

    @Test
    fun `global serializes to global`() {
        assertEquals("global", Scope.Global.serialize())
    }

    @Test
    fun `feature serializes to feature colon name`() {
        assertEquals("feature:Connect", Scope.Feature("Connect").serialize())
    }

    @Test
    fun `instance serializes to instance colon feature colon tag`() {
        assertEquals("instance:Connect:tag1", Scope.Instance("Connect", "tag1").serialize())
    }

    @Test
    fun `deserialize global`() {
        assertEquals(Scope.Global, Scope.deserialize("global"))
    }

    @Test
    fun `deserialize feature`() {
        assertEquals(Scope.Feature("Connect"), Scope.deserialize("feature:Connect"))
    }

    @Test
    fun `deserialize instance`() {
        assertEquals(Scope.Instance("Connect", "tag1"), Scope.deserialize("instance:Connect:tag1"))
    }

    @Test
    fun `unknown string falls back to global`() {
        assertEquals(Scope.Global, Scope.deserialize("unknown"))
    }

    @Test
    fun `fromEnvelopeMap global`() {
        assertEquals(Scope.Global, Scope.fromEnvelopeMap(mapOf("kind" to "global")))
    }

    @Test
    fun `fromEnvelopeMap feature`() {
        assertEquals(Scope.Feature("LiA"), Scope.fromEnvelopeMap(mapOf("kind" to "feature", "feature" to "LiA")))
    }

    @Test
    fun `fromEnvelopeMap instance`() {
        assertEquals(
            Scope.Instance("LiA", "1234"),
            Scope.fromEnvelopeMap(mapOf("kind" to "instance", "feature" to "LiA", "instance" to "1234")),
        )
    }
}
