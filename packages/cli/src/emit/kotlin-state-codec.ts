import type { CodecWalker } from './codec.js';
import type { SchemaNode } from './types.js';

function buildBridgeValueDecodeExpr(
  bridgeValueExpr: string,
  valueSchema: SchemaNode,
  valueCtx: string,
  fieldName: string,
  walker: CodecWalker,
): string {
  const decode = (rawExpr: string): string =>
    walker.decodeExpr(rawExpr, valueSchema, valueCtx, fieldName);
  return `when (${bridgeValueExpr}) {
                    is BridgeValue.Available -> BridgeValue.Available(${decode(`${bridgeValueExpr}.value`)})
                    is BridgeValue.Initial -> BridgeValue.Initial(${decode(`${bridgeValueExpr}.value`)})
                    is BridgeValue.Replacing -> BridgeValue.Replacing(${bridgeValueExpr}.lastKnown?.let { raw -> ${decode('raw')} })
                    is BridgeValue.Unprovided -> BridgeValue.Unprovided(${bridgeValueExpr}.lastKnown?.let { raw -> ${decode('raw')} })
                }`;
}

export function buildStateFlowDecodeExpr(
  memberName: string,
  valueSchema: SchemaNode,
  valueType: string,
  valueCtx: string,
  fieldName: string,
  walker: CodecWalker,
): string {
  const decodeStateValue = buildBridgeValueDecodeExpr(
    'stateValue',
    valueSchema,
    valueCtx,
    fieldName,
    walker,
  );
  return `run {
                    val source = caller.state("${memberName}")
                    fun decodeStateValue(stateValue: BridgeValue<Any?>): BridgeValue<${valueType}> = ${decodeStateValue}
                    @OptIn(kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi::class)
                    object : kotlinx.coroutines.flow.StateFlow<BridgeValue<${valueType}>> {
                        override val replayCache: List<BridgeValue<${valueType}>>
                            get() = source.replayCache.map { value -> decodeStateValue(value) }
                        override val value: BridgeValue<${valueType}>
                            get() = decodeStateValue(source.value)
                        override suspend fun collect(collector: kotlinx.coroutines.flow.FlowCollector<BridgeValue<${valueType}>>): Nothing {
                            source.collect { value -> collector.emit(decodeStateValue(value)) }
                        }
                    }
                }`;
}

export function buildStateFlowEncodeExpr(
  sourceExpr: string,
  valueSchema: SchemaNode,
  valueType: string,
  valueCtx: string,
  walker: CodecWalker,
): string {
  const encodeValue = walker.encodeExpr('value', valueSchema, valueCtx);
  return `run {
                        val source = ${sourceExpr}
                        fun encodeStateValue(value: ${valueType}): Any? = ${encodeValue}
                        @OptIn(kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi::class)
                        object : kotlinx.coroutines.flow.StateFlow<Any?> {
                            override val replayCache: List<Any?>
                                get() = source.replayCache.map { value -> encodeStateValue(value) }
                            override val value: Any?
                                get() = encodeStateValue(source.value)
                            override suspend fun collect(collector: kotlinx.coroutines.flow.FlowCollector<Any?>): Nothing {
                                source.collect { value -> collector.emit(encodeStateValue(value)) }
                            }
                        }
                    }`;
}
