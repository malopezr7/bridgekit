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
     *
     * The map is always framework-constructed (codec output), so every value must be
     * AnyMap-compatible (primitives, plain maps, lists). Passing ignoreIncompatible=false
     * makes any incompatible value throw immediately — an incompatible value here is always
     * a framework/codegen bug, not a user error, and we want it to surface loudly.
     */
    fun toAnyMap(map: Map<String, Any?>): AnyMap =
        AnyMap.fromMap(map, false)

    /**
     * Convert an [AnyMap] from the Nitro bridge to a plain [Map].
     * Returns an empty map if [anyMap] is null.
     */
    fun fromAnyMap(anyMap: AnyMap?): Map<String, Any?> =
        anyMap?.toHashMap() ?: emptyMap()
}
