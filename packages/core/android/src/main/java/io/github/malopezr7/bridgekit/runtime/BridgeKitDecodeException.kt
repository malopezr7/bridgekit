package io.github.malopezr7.bridgekit.runtime

/**
 * Thrown by GENERATED contract decoders when a required field is absent or has the
 * wrong type on the wire (fail-fast decode).
 *
 * Generated codecs throw this instead of fabricating defaults (`""`, `0.0`, `false`,
 * `emptyList()`). The Router catches it and maps it to a `VALIDATION_FAILED` wire
 * error, mirroring the JS-side inbound validation so the codec is symmetric.
 *
 * Lives in `io.github.malopezr7.bridgekit.runtime` (not `core`) so generated code — which only
 * imports the runtime package — can throw it without depending on engine internals.
 */
class BridgeKitDecodeException(
    val field: String,
    val expectedType: String,
) : RuntimeException("Missing or wrong-typed required field '$field' (expected $expectedType)")
