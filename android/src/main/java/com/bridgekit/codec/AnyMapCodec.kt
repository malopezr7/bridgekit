package com.bridgekit.codec

import com.margelo.nitro.core.AnyMap

/**
 * Bulk AnyMap ↔ Map<String, Any?> conversion helpers.
 *
 * AnyMap.fromMap / toHashMap are the single JNI hop for all cross-bridge data.
 * All Hybrid implementations must use ONLY these helpers — never iterate fields individually.
 */
object AnyMapCodec {
    /**
     * Convert a plain [Map] to [AnyMap] for passing across the Nitro bridge.
     * Incompatible values (e.g. custom objects) are silently ignored per Nitro semantics.
     */
    fun toAnyMap(map: Map<String, Any?>): AnyMap =
        AnyMap.fromMap(map, true)

    /**
     * Convert an [AnyMap] from the Nitro bridge to a plain [Map].
     * Returns an empty map if [anyMap] is null.
     */
    fun fromAnyMap(anyMap: AnyMap?): Map<String, Any?> =
        anyMap?.toHashMap() ?: emptyMap()
}
