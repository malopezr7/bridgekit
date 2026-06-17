package com.bridgekit.core

/**
 * Exception thrown by the BridgeKit consume-side proxy on call failure.
 *
 * Always carries a [code] matching one of the ERROR_CODES in the wire protocol.
 * Use [code] for programmatic handling; never rely on the message text.
 */
class BridgeKitException(
    val code: String,
    message: String,
    val contractId: String? = null,
    val member: String? = null,
    val scope: Scope? = null,
) : RuntimeException(
    buildMessage(code, message, contractId, member, scope),
) {
    companion object {
        private fun buildMessage(
            code: String,
            message: String,
            contractId: String?,
            member: String?,
            scope: Scope?,
        ): String = buildString {
            append("$code: $message")
            if (contractId != null) append(" [contract=$contractId")
            if (member != null) append(", member=$member")
            if (scope != null) append(", scope=${scope.serialize()}")
            if (contractId != null) append("]")
        }

        fun fromEnvelope(map: Map<String, Any?>, defaultContractId: String? = null): BridgeKitException {
            val code = (map["code"] as? String) ?: "PROVIDER_ERROR"
            val msg = (map["message"] as? String) ?: "Unknown bridgekit error"
            val cid = (map["contractId"] as? String) ?: defaultContractId
            val member = map["member"] as? String
            val scopeMap = map["scope"] as? Map<*, *>
            val scope = scopeMap?.let {
                @Suppress("UNCHECKED_CAST")
                Scope.fromEnvelopeMap(it as Map<String, Any?>)
            }
            return BridgeKitException(code, msg, cid, member, scope)
        }
    }
}
