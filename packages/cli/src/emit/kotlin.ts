// emit/kotlin.ts — Kotlin code generation from a ContractDescriptor.

import type { RawContractToken } from '../load.js';
import { assembleContractFile, type EmitResult } from './assemble.js';
import { CodecWalker, schemaNeedsCodec } from './codec.js';
import {
  type ArrayNode,
  contractIdToClassName,
  contractIdToPackage,
  hashMember,
  KotlinTypeEmitter,
  kotlinLiteral,
  type NullableNode,
  type ObjectNode,
  type OneOfNode,
  type OptionalNode,
  type RecordNode,
  type SchemaNode,
  type TupleNode,
  toKotlinMemberName,
  toPascalCase,
  type UnionNode,
} from './types.js';

export type { EmitResult };
export { contractIdToPackage };

// ---- per-method code emission ----------------------------------------------

interface MethodDescRaw {
  kind: 'fire' | 'query' | 'querySync';
  params?: ObjectNode;
  result?: SchemaNode;
  timeoutMs?: number | null;
}

interface StreamDescRaw {
  kind: 'stream';
  value: SchemaNode;
  params?: ObjectNode;
}

interface StateDescRaw {
  kind: 'state';
  value: SchemaNode;
  initial: unknown;
}

/** True when a kind is encoded inline (no composite codec fn) at a method boundary. */
function isInlineResultKind(kind: string): boolean {
  return (
    kind === 'string' ||
    kind === 'number' ||
    kind === 'boolean' ||
    kind === 'json' ||
    kind === 'void'
  );
}

/** Unwrap optional/nullable to the first structured/primitive inner node. */
function unwrapWrappers(node: SchemaNode): SchemaNode {
  let inner = node;
  while (inner.kind === 'optional' || inner.kind === 'nullable') {
    inner = (inner as OptionalNode | NullableNode).inner;
  }
  return inner;
}

function buildOutboundReturnLines(
  resultSchema: SchemaNode | null,
  resultType: string,
  isNullable: boolean,
  memberName: string,
  resultCtx: string,
  walker: CodecWalker,
): string[] {
  if (!resultSchema || resultType === 'Unit') return [`                return Unit`];

  const innerSchema = unwrapWrappers(resultSchema);
  // Primitive arrays and scalars keep the bare safe-cast (no codec needed).
  const isPlainCast = !schemaNeedsCodec(innerSchema);

  if (isPlainCast) {
    const bareType = resultType.replace(/\?$/, '');
    if (isNullable) {
      return [
        `                @Suppress("UNCHECKED_CAST")`,
        `                return result as? ${bareType}`,
      ];
    }
    return [
      `                @Suppress("UNCHECKED_CAST")`,
      `                return result as? ${bareType} ?: throw IllegalStateException("Unexpected null result for ${memberName}")`,
    ];
  }

  // Structured: decode through the walker boundary idiom. Null handling lives on
  // the outer return — a nullable result returns null rather than throwing.
  const decodeExpr = walker.boundaryDecode('result', innerSchema, resultCtx);
  if (isNullable) {
    return [
      `                @Suppress("UNCHECKED_CAST")`,
      `                return if (result == null) null else ${decodeExpr}`,
    ];
  }
  return [`                @Suppress("UNCHECKED_CAST")`, `                return ${decodeExpr}`];
}

function buildInboundEncodeExpr(
  resultSchema: SchemaNode,
  callExpr: string,
  resultCtx: string,
  walker: CodecWalker,
): string {
  const inner = unwrapWrappers(resultSchema);
  if (isInlineResultKind(inner.kind) || !schemaNeedsCodec(inner)) return callExpr;
  const isNullable = resultSchema.kind === 'optional' || resultSchema.kind === 'nullable';
  if (isNullable) {
    return `${callExpr}?.let { ${walker.boundaryEncode('it', inner, resultCtx)} }`;
  }
  return walker.boundaryEncode(callExpr, inner, resultCtx);
}

// ---- main emitter ----------------------------------------------------------

const CODEGEN_VERSION = '1';

export function emitKotlinContract(token: RawContractToken, kotlinPackage: string): EmitResult {
  const descriptor = token.descriptor;
  const id = descriptor.id;
  const hash = token.hash;
  const className = contractIdToClassName(id);
  const fileName = `${className}Contract.kt`;

  const typeEmitter = new KotlinTypeEmitter(className);

  // Emit method signatures for provider interface
  const providerMethods: string[] = [];
  const clientMethods: string[] = [];
  const inboundImpls: string[] = [];
  const outboundImpls: string[] = [];
  const memberHashPairs: string[] = [];
  const encodeDecodeFns: string[] = [];

  const registeredCodecs = new Set<string>();
  const registerCodecFn = (fn: string): void => {
    const m = fn.match(/^fun (encode|decode)([A-Za-z0-9_]+)\(/);
    const baseName = m ? m[2] : null;
    if (baseName && encodeDecodeFns.some((existing) => existing.includes(`encode${baseName}(`))) {
      return;
    }
    encodeDecodeFns.push(fn);
  };
  const walker = new CodecWalker(typeEmitter, className, registerCodecFn, registeredCodecs);

  /** Registers a top-level object codec (params) through the walker. */
  const registerObjectCodec = (dataClassName: string, objNode: ObjectNode): void => {
    if (encodeDecodeFns.some((fn) => fn.includes(`encode${dataClassName}(`))) return;
    registeredCodecs.add(dataClassName);
    encodeDecodeFns.push(walker.emitObjectCodec(dataClassName, objNode));
  };

  // ---- methods ----
  for (const [memberName, rawDesc] of Object.entries(descriptor.methods)) {
    const desc = rawDesc as MethodDescRaw;
    const kName = toKotlinMemberName(memberName);

    memberHashPairs.push(`"methods.${memberName}" to "${hashMember(rawDesc)}"`);

    if (desc.kind === 'fire') {
      let paramsType = '';
      if (desc.params) {
        const dataClassName = `${toPascalCase(kName)}Params`;
        typeEmitter.emit(desc.params, dataClassName);
        paramsType = dataClassName;
      }

      const paramSig = paramsType ? `(params: ${paramsType})` : '()';
      providerMethods.push(`    fun ${kName}${paramSig}`);
      clientMethods.push(`    fun ${kName}${paramSig}`);

      // inbound adapter
      if (paramsType) {
        inboundImpls.push(
          [
            `            "${memberName}" -> {`,
            `                val decoded = ${className}Codecs.decode${paramsType}(payload ?: emptyMap<String, Any?>())`,
            `                impl.${kName}(decoded)`,
            `                null`,
            `            }`,
          ].join('\n'),
        );
      } else {
        inboundImpls.push([`            "${memberName}" -> { impl.${kName}(); null }`].join('\n'));
      }

      // outbound (native consumes a JS-provided Void → fire-and-forget, never sync)
      if (paramsType) {
        outboundImpls.push(
          [
            `            override fun ${kName}(params: ${paramsType}) {`,
            `                caller.fire("${memberName}", ${className}Codecs.encode${paramsType}(params))`,
            `            }`,
          ].join('\n'),
        );
      } else {
        outboundImpls.push(
          [`            override fun ${kName}() { caller.fire("${memberName}", null) }`].join('\n'),
        );
      }
    } else if (desc.kind === 'query' || desc.kind === 'querySync') {
      let paramsType = '';
      let resultType = 'Unit';

      if (desc.params) {
        const dataClassName = `${toPascalCase(kName)}Params`;
        typeEmitter.emit(desc.params, dataClassName);
        paramsType = dataClassName;
      }

      const resultCtx = `${toPascalCase(kName)}Result`;
      if (desc.result) {
        const res = typeEmitter.emit(desc.result, resultCtx);
        resultType = res.typeName;
      }

      const paramSig = paramsType ? `(params: ${paramsType})` : '()';
      const suspendMod = desc.kind === 'query' ? 'suspend ' : '';

      providerMethods.push(`    ${suspendMod}fun ${kName}${paramSig}: ${resultType}`);
      clientMethods.push(`    ${suspendMod}fun ${kName}${paramSig}: ${resultType}`);

      // inbound adapter (simplified — full codec per field would be verbose)
      const invokeCall = desc.kind === 'querySync' ? 'invokeSync' : 'invoke';
      const encodeParams = paramsType ? `${className}Codecs.encode${paramsType}(params)` : 'null';

      const isNullableResult = resultType.endsWith('?');

      const returnLines = buildOutboundReturnLines(
        desc.result ?? null,
        resultType,
        isNullableResult,
        memberName,
        resultCtx,
        walker,
      );

      const inboundCallExprBase = paramsType ? `impl.${kName}(decoded)` : `impl.${kName}()`;
      const inboundResultExpr = desc.result
        ? buildInboundEncodeExpr(desc.result, inboundCallExprBase, resultCtx, walker)
        : inboundCallExprBase;

      if (desc.kind === 'querySync') {
        inboundImpls.push(
          [
            `            "${memberName}" -> {`,
            paramsType
              ? `                val decoded = ${className}Codecs.decode${paramsType}(payload ?: emptyMap<String, Any?>())`
              : '',
            `                ${inboundResultExpr}`,
            `            }`,
          ]
            .filter(Boolean)
            .join('\n'),
        );
        outboundImpls.push(
          [
            `            override fun ${kName}${paramSig}: ${resultType} {`,
            `                val result = caller.${invokeCall}("${memberName}", ${encodeParams})`,
            ...returnLines,
            `            }`,
          ].join('\n'),
        );
      } else {
        inboundImpls.push(
          [
            `            "${memberName}" -> {`,
            paramsType
              ? `                val decoded = ${className}Codecs.decode${paramsType}(payload ?: emptyMap<String, Any?>())`
              : '',
            `                ${inboundResultExpr}`,
            `            }`,
          ]
            .filter(Boolean)
            .join('\n'),
        );
        outboundImpls.push(
          [
            `            override suspend fun ${kName}${paramSig}: ${resultType} {`,
            `                val result = caller.${invokeCall}("${memberName}", ${encodeParams})`,
            ...returnLines,
            `            }`,
          ].join('\n'),
        );
      }

      if (paramsType && desc.params) {
        registerObjectCodec(paramsType, desc.params);
      }
    }
  }

  // ---- streams ----
  for (const [memberName, rawDesc] of Object.entries(descriptor.streams)) {
    const desc = rawDesc as StreamDescRaw;
    const kName = toKotlinMemberName(memberName);
    const valueResult = typeEmitter.emit(desc.value, `${toPascalCase(kName)}Value`);
    const flowType = `kotlinx.coroutines.flow.Flow<${valueResult.typeName}>`;

    memberHashPairs.push(`"streams.${memberName}" to "${hashMember(rawDesc)}"`);

    // emit typed params when desc.params is present
    let streamParamsType = '';
    if (desc.params) {
      const dataClassName = `${toPascalCase(kName)}Params`;
      typeEmitter.emit(desc.params, dataClassName);
      streamParamsType = dataClassName;
      registerObjectCodec(dataClassName, desc.params);
    }

    const paramSig = streamParamsType ? `(params: ${streamParamsType})` : '()';

    providerMethods.push(`    fun ${kName}${paramSig}: ${flowType}`);
    clientMethods.push(`    fun ${kName}${paramSig}: ${flowType}`);

    const encodeStreamParams = streamParamsType
      ? `${className}Codecs.encode${streamParamsType}(params)`
      : 'null';

    const valueCtx = `${toPascalCase(kName)}Value`;
    if (schemaNeedsCodec(desc.value)) {
      const decodeItem = walker.decodeExpr('it', desc.value, valueCtx, `${kName}.value`);
      outboundImpls.push(
        `            override fun ${kName}${paramSig}: ${flowType} =\n                caller.stream("${memberName}", ${encodeStreamParams}).map { @Suppress("UNCHECKED_CAST") ${decodeItem} }`,
      );
    } else {
      outboundImpls.push(
        `            override fun ${kName}${paramSig}: ${flowType} =\n                @Suppress("UNCHECKED_CAST") caller.stream("${memberName}", ${encodeStreamParams}) as ${flowType}`,
      );
    }
  }

  // ---- state ----
  for (const [memberName, rawDesc] of Object.entries(descriptor.state)) {
    const desc = rawDesc as StateDescRaw;
    const kName = toKotlinMemberName(memberName);
    const valueResult = typeEmitter.emit(desc.value, toPascalCase(kName));

    memberHashPairs.push(`"state.${memberName}" to "${hashMember(rawDesc)}"`);

    providerMethods.push(
      `    val ${kName}: kotlinx.coroutines.flow.MutableStateFlow<${valueResult.typeName}>`,
    );
    clientMethods.push(
      `    val ${kName}: kotlinx.coroutines.flow.StateFlow<com.bridgekit.runtime.BridgeValue<${valueResult.typeName}>>`,
    );

    outboundImpls.push(
      `            override val ${kName}: kotlinx.coroutines.flow.StateFlow<com.bridgekit.runtime.BridgeValue<${valueResult.typeName}>>\n                get() = @Suppress("UNCHECKED_CAST") caller.state("${memberName}") as kotlinx.coroutines.flow.StateFlow<com.bridgekit.runtime.BridgeValue<${valueResult.typeName}>>`,
    );
  }

  // ---- encode/decode for params objects (covers fire/Void params too) ----
  for (const [memberName, rawDesc] of Object.entries(descriptor.methods)) {
    const desc = rawDesc as MethodDescRaw;
    if (desc.params) {
      const dataClassName = `${toPascalCase(toKotlinMemberName(memberName))}Params`;
      registerObjectCodec(dataClassName, desc.params);
    }
  }

  // ---- inbound invoke_sync (querySync only) ----
  const syncImpls: string[] = [];
  for (const [memberName, rawDesc] of Object.entries(descriptor.methods)) {
    const desc = rawDesc as MethodDescRaw;
    if (desc.kind !== 'querySync') continue;
    const kName = toKotlinMemberName(memberName);
    const paramsType = desc.params ? `${toPascalCase(kName)}Params` : '';
    const resultCtx = `${toPascalCase(kName)}Result`;
    const implCall = paramsType ? `impl.${kName}(decoded)` : `impl.${kName}()`;
    const resultExpr = desc.result
      ? buildInboundEncodeExpr(desc.result, implCall, resultCtx, walker)
      : implCall;
    const body = [`            "${memberName}" -> {`];
    if (paramsType) {
      body.push(
        `                val decoded = ${className}Codecs.decode${paramsType}(payload ?: emptyMap<String, Any?>())`,
      );
    }
    body.push(`                ${resultExpr}`);
    body.push(`            }`);
    syncImpls.push(body.join('\n'));
  }

  // ---- inbound openStream (encode object/union values per B6) ----
  const streamImpls: string[] = [];
  for (const [memberName, rawDesc] of Object.entries(descriptor.streams)) {
    const desc = rawDesc as StreamDescRaw;
    const kName = toKotlinMemberName(memberName);
    const streamParamsType = desc.params ? `${toPascalCase(kName)}Params` : '';
    const callExpr = streamParamsType
      ? `impl.${kName}(${className}Codecs.decode${streamParamsType}(payload ?: emptyMap<String, Any?>()))`
      : `impl.${kName}()`;
    const valueCtx = `${toPascalCase(kName)}Value`;
    if (schemaNeedsCodec(desc.value)) {
      const encodeItem = walker.encodeExpr('item', desc.value, valueCtx);
      streamImpls.push(
        `            "${memberName}" -> @Suppress("UNCHECKED_CAST") ${callExpr}.map { item -> ${encodeItem} as Any? }`,
      );
    } else {
      streamImpls.push(
        `            "${memberName}" -> @Suppress("UNCHECKED_CAST") ${callExpr} as kotlinx.coroutines.flow.Flow<Any?>`,
      );
    }
  }

  // ---- state initials + stateFlows entries ----
  const stateInitials: string[] = Object.entries(descriptor.state).map(([memberName, rawDesc]) => {
    const desc = rawDesc as StateDescRaw;
    return `                "${memberName}" to ${kotlinLiteral(desc.initial)},`;
  });
  const stateFlowEntries = Object.keys(descriptor.state).map((memberName) => {
    const kName = toKotlinMemberName(memberName);
    return `                    "${memberName}" to @Suppress("UNCHECKED_CAST") impl.${kName} as kotlinx.coroutines.flow.StateFlow<Any?>`;
  });

  // Flow.map is needed when any stream value is encoded/decoded per item (B6).
  const streamNeedsFlowMap = Object.values(descriptor.streams).some((s) =>
    schemaNeedsCodec((s as StreamDescRaw).value),
  );

  // java.time.Instant import needed when any schema node (at any depth) uses 'date'.
  // Recurses into all composite kinds: object, array, optional/nullable, record,
  // union (variant fields), tuple (items), oneOf (options).
  function schemaUsesDate(node: SchemaNode | null | undefined): boolean {
    if (!node) return false;
    if (node.kind === 'date') return true;
    if (node.kind === 'object') {
      return Object.values((node as ObjectNode).fields).some(schemaUsesDate);
    }
    if (node.kind === 'array') return schemaUsesDate((node as ArrayNode).item);
    if (node.kind === 'optional' || node.kind === 'nullable') {
      return schemaUsesDate((node as OptionalNode | NullableNode).inner);
    }
    // 5.10 extra: recurse into record value, union variant fields, tuple items, oneOf options
    if (node.kind === 'record') return schemaUsesDate((node as RecordNode).value);
    if (node.kind === 'union') {
      return Object.values((node as UnionNode).variants).some((variant) =>
        Object.values(variant.fields).some(schemaUsesDate),
      );
    }
    if (node.kind === 'tuple') return (node as TupleNode).items.some(schemaUsesDate);
    if (node.kind === 'oneOf') return (node as OneOfNode).options.some(schemaUsesDate);
    return false;
  }
  const needsInstantImport =
    Object.values(descriptor.methods).some((m) => {
      const d = m as MethodDescRaw;
      return schemaUsesDate(d.params ?? null) || schemaUsesDate(d.result ?? null);
    }) ||
    Object.values(descriptor.streams).some((s) => schemaUsesDate((s as StreamDescRaw).value)) ||
    // 5.10 extra: state values may also contain date fields
    Object.values(descriptor.state).some((s) => schemaUsesDate((s as StateDescRaw).value));

  // BridgeKitDecodeException import needed when any method result, stream item, or
  // state value resolves (recursively, same depth rules as schemaUsesDate) to a scalar
  // that hits boundaryDecode's throw path: date, binary, enum, int64.
  // Also true when encodeDecodeFns is non-empty (object/union codec path already throws).
  // Recurses the same composite kinds so nested scalars are caught.
  function schemaUsesBoundaryDecodeThrow(node: SchemaNode | null | undefined): boolean {
    if (!node) return false;
    if (
      node.kind === 'date' ||
      node.kind === 'binary' ||
      node.kind === 'enum' ||
      node.kind === 'int64'
    ) {
      return true;
    }
    if (node.kind === 'object') {
      return Object.values((node as ObjectNode).fields).some(schemaUsesBoundaryDecodeThrow);
    }
    if (node.kind === 'array') return schemaUsesBoundaryDecodeThrow((node as ArrayNode).item);
    if (node.kind === 'optional' || node.kind === 'nullable') {
      return schemaUsesBoundaryDecodeThrow((node as OptionalNode | NullableNode).inner);
    }
    if (node.kind === 'record') return schemaUsesBoundaryDecodeThrow((node as RecordNode).value);
    if (node.kind === 'union') {
      return Object.values((node as UnionNode).variants).some((variant) =>
        Object.values(variant.fields).some(schemaUsesBoundaryDecodeThrow),
      );
    }
    if (node.kind === 'tuple') {
      return (node as TupleNode).items.some(schemaUsesBoundaryDecodeThrow);
    }
    if (node.kind === 'oneOf') {
      return (node as OneOfNode).options.some(schemaUsesBoundaryDecodeThrow);
    }
    return false;
  }
  const needsBridgeKitDecodeException =
    Object.values(descriptor.methods).some((m) => {
      const d = m as MethodDescRaw;
      return schemaUsesBoundaryDecodeThrow(d.result ?? null);
    }) ||
    Object.values(descriptor.streams).some((s) =>
      schemaUsesBoundaryDecodeThrow((s as StreamDescRaw).value),
    ) ||
    Object.values(descriptor.state).some((s) =>
      schemaUsesBoundaryDecodeThrow((s as StateDescRaw).value),
    );

  return assembleContractFile({
    fileName,
    id,
    hash,
    kotlinPackage,
    className,
    codegenVersion: CODEGEN_VERSION,
    typeDecls: typeEmitter.getDeclarations(),
    providerMethods,
    clientMethods,
    encodeDecodeFns,
    memberHashPairs,
    inboundImpls,
    syncImpls,
    streamImpls,
    outboundImpls,
    stateInitials,
    stateFlowEntries,
    streamNeedsFlowMap,
    needsInstantImport,
    needsBridgeKitDecodeException,
  });
}
