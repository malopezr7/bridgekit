package io.github.malopezr7.bridgekit.core

/**
 * Scope for a contract binding. Resolution walks: Instance → Feature → Global.
 *
 * Wire serialization matches the TS side's serializeScope:
 *   Global      → "global"
 *   Feature(n)  → "feature:n"
 *   Instance(f,t) → "instance:f:t"
 *
 * JSON envelope shape: { kind: "global"|"feature"|"instance", feature?, instance? }
 */
sealed class Scope {
    object Global : Scope()
    data class Feature(val name: String) : Scope()
    data class Instance(val feature: String, val tag: String) : Scope()

    fun serialize(): String = when (this) {
        is Global -> "global"
        is Feature -> "feature:$name"
        is Instance -> "instance:$feature:$tag"
    }

    companion object {
        /** Parse a serialized scope string. Falls back to Global for unknown formats. */
        fun deserialize(s: String): Scope = when {
            s == "global" -> Global
            s.startsWith("feature:") -> Feature(s.removePrefix("feature:"))
            s.startsWith("instance:") -> {
                val parts = s.removePrefix("instance:").split(":", limit = 2)
                Instance(parts.getOrElse(0) { "" }, parts.getOrElse(1) { "" })
            }
            else -> Global
        }

        /**
         * Parse from a wire envelope map: { kind: "global"|"feature"|"instance", feature?, instance? }
         */
        fun fromEnvelopeMap(map: Map<String, Any?>): Scope {
            return when (map["kind"] as? String) {
                "feature" -> Feature(map["feature"] as? String ?: "")
                "instance" -> Instance(
                    map["feature"] as? String ?: "",
                    map["instance"] as? String ?: "",
                )
                else -> Global
            }
        }
    }
}
