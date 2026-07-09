// emit/codec.ts — unified recursive codec walker for Kotlin codegen (D2, D9).
// One instance per contract. Borrows type names from KotlinTypeEmitter so codec
// fn names always match emitted type names. Composites register on demand.

import {
  type ArrayNode,
  escapeKotlinIdentifier,
  type KotlinTypeEmitter,
  kotlinStringLiteral,
  type NullableNode,
  type ObjectNode,
  type OneOfNode,
  type OptionalNode,
  type RecordNode,
  type SchemaNode,
  type TupleNode,
  toPascalCase,
  type UnionNode,
} from './types.js';

export function schemaNeedsCodec(node: SchemaNode): boolean {
  switch (node.kind) {
    case 'object':
    case 'union':
    case 'literals':
    case 'tuple':
    case 'oneOf':
      return true;
    // C-2: scalar types that require boundary codec transformation.
    // date: epoch-ms Long → Instant (boundaryDecode uses Instant.ofEpochMilli).
    // binary: base64 String → ByteArray (boundaryDecode uses Base64.decode).
    // enum: Int wire value → enum class via fromWire() (boundaryDecode already handles).
    // int64: defensive — Long passes through natively but uniform rule + Swift-portable.
    // encodeExpr and boundaryDecode already have correct cases for all four; only
    // the gating (isPlainCast = !schemaNeedsCodec) was bypassing them.
    case 'date':
    case 'binary':
    case 'enum':
    case 'int64':
      return true;
    case 'array':
      return schemaNeedsCodec((node as ArrayNode).item);
    case 'record':
      return schemaNeedsCodec((node as RecordNode).value);
    case 'optional':
    case 'nullable':
      return schemaNeedsCodec((node as OptionalNode | NullableNode).inner);
    default:
      return false;
  }
}

export class CodecWalker {
  private readonly emitter: KotlinTypeEmitter;
  private readonly className: string;
  /** Sink for generated composite codec functions (object/union). */
  private readonly register: (fn: string) => void;
  /** Names of composites already registered — prevents duplicate emission. */
  private readonly registered: Set<string>;

  constructor(
    emitter: KotlinTypeEmitter,
    className: string,
    register: (fn: string) => void,
    registered: Set<string>,
  ) {
    this.emitter = emitter;
    this.className = className;
    this.register = register;
    this.registered = registered;
  }

  /** The exact Kotlin type name the emitter assigns to `node` at `ctxName`. */
  private typeName(node: SchemaNode, ctxName: string): string {
    return this.emitter.emit(node, ctxName).typeName.replace(/\?$/, '');
  }

  // ---- method-boundary idioms --------------------------------------------
  // At a method result boundary the null handling lives on the OUTER return
  // (`if (result == null) null else ...` / `?: throw IllegalState`), so the
  // composite cast here is a bare `as Map<*, *>` (no per-field fail-fast). This
  // is intentionally distinct from the field idiom while sharing the SAME walker
  // for recursion, naming, and registration — there is still ONE codec.

  /**
   * Encodes a method result/argument (`expr`, already the bare inner kind) for the
   * wire, registering any composite codec. Wrappers recurse via `encodeExpr`.
   */
  boundaryEncode(expr: string, node: SchemaNode, ctxName: string): string {
    if (
      node.kind === 'object' ||
      node.kind === 'union' ||
      node.kind === 'tuple' ||
      node.kind === 'oneOf'
    ) {
      const typeName = this.registerComposite(node, ctxName);
      return `${this.className}Codecs.encode${typeName}(${expr})`;
    }
    return this.encodeExpr(expr, node, ctxName);
  }

  /**
   * Decodes a non-null method result (`expr`, already the bare inner kind) from the
   * wire, registering any composite codec. Object/union use a bare `as Map<*, *>`;
   * arrays/records/literals reuse the inline walker decode.
   */
  boundaryDecode(expr: string, node: SchemaNode, ctxName: string): string {
    switch (node.kind) {
      case 'object':
      case 'union':
      case 'oneOf': {
        const typeName = this.registerComposite(node, ctxName);
        return `${this.className}Codecs.decode${typeName}(${expr} as Map<*, *>)`;
      }
      case 'tuple': {
        const typeName = this.registerComposite(node, ctxName);
        return `${this.className}Codecs.decode${typeName}(${expr} as List<*>)`;
      }
      case 'literals': {
        const typeName = this.typeName(node, ctxName);
        return `${typeName}.fromWire(${expr} as? String ?: "") ?: throw IllegalStateException("Unknown ${typeName} wire value: \${${expr}}")`;
      }
      case 'enum': {
        const typeName = this.typeName(node, ctxName);
        return `${typeName}.fromWire(when (val v = ${expr}) { is Number -> v.toInt(); else -> throw BridgeKitDecodeException("result", "${typeName}") }) ?: throw IllegalStateException("Unknown ${typeName} wire value: \${${expr}}")`;
      }
      case 'date':
        return `java.time.Instant.ofEpochMilli(when (val v = ${expr}) { is Number -> v.toLong(); else -> throw BridgeKitDecodeException("result", "Instant") })`;
      case 'int64':
        return `when (val v = ${expr}) { is String -> v.toLong(); else -> throw BridgeKitDecodeException("result", "Long") }`;
      case 'binary':
        return `android.util.Base64.decode(${expr} as? String ?: throw BridgeKitDecodeException("result", "ByteArray"), android.util.Base64.NO_WRAP)`;
      default:
        // array / record / primitive — inline walker decode (item composites still register).
        return this.decodeExpr(expr, node, ctxName, ctxName);
    }
  }

  // ---- ENCODE -------------------------------------------------------------

  /**
   * Returns a Kotlin expression that encodes `expr` (a typed Kotlin value at
   * `ctxName`) into its AnyMap wire form. Recurses through wrappers; bottoms out
   * in composite-function calls (which are registered as a side effect).
   */
  encodeExpr(expr: string, node: SchemaNode, ctxName: string): string {
    switch (node.kind) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'json':
        return expr;
      case 'void':
        return 'null';
      case 'literals':
        return `${expr}.wireValue`;

      case 'optional':
      case 'nullable': {
        const inner = (node as OptionalNode | NullableNode).inner;
        return `${expr}?.let { ${this.encodeExpr('it', inner, ctxName)} }`;
      }

      case 'array': {
        const item = (node as ArrayNode).item;
        const itemCtx = `${ctxName}Item`;
        return `${expr}.map { ${this.encodeExpr('it', item, itemCtx)} }`;
      }

      case 'record': {
        const value = (node as RecordNode).value;
        const valueCtx = `${ctxName}Value`;
        return `${expr}.mapValues { ${this.encodeExpr('it.value', value, valueCtx)} }`;
      }

      case 'int64':
        return `${expr}.toString()`;

      case 'date':
        // encode Date → epoch millis (Long)
        return `${expr}.toEpochMilli()`;

      case 'binary': {
        // encode ByteArray → base64 string
        return `android.util.Base64.encodeToString(${expr}, android.util.Base64.NO_WRAP)`;
      }

      case 'enum': {
        // encode enum → wireValue (Int)
        return `${expr}.wireValue`;
      }

      case 'object':
      case 'union':
      case 'tuple':
      case 'oneOf': {
        const typeName = this.registerComposite(node, ctxName);
        return `${this.className}Codecs.encode${typeName}(${expr})`;
      }

      default:
        return expr;
    }
  }

  // ---- DECODE -------------------------------------------------------------

  /**
   * Returns a Kotlin expression that decodes `raw` (an `Any?` from the wire) into
   * the typed Kotlin value at `ctxName`. Required values fail-fast (W1-5) via
   * BridgeKitDecodeException; optional/nullable wrappers guard null at the wrapper.
   * `fieldName` names the field in any thrown exception.
   */
  decodeExpr(raw: string, node: SchemaNode, ctxName: string, fieldName = 'value'): string {
    const fieldLit = kotlinStringLiteral(fieldName);
    switch (node.kind) {
      case 'string':
        return `(${raw} as? String) ?: throw BridgeKitDecodeException(${fieldLit}, "String")`;
      case 'number':
        return `when (val v = ${raw}) { is Number -> v.toDouble(); else -> throw BridgeKitDecodeException(${fieldLit}, "Double") }`;
      case 'boolean':
        return `${raw} as? Boolean ?: throw BridgeKitDecodeException(${fieldLit}, "Boolean")`;
      case 'json':
        return raw;
      case 'void':
        return 'Unit';

      case 'optional':
      case 'nullable': {
        const inner = (node as OptionalNode | NullableNode).inner;
        return `if (${raw} == null) null else ${this.decodeExpr(raw, inner, ctxName, fieldName)}`;
      }

      case 'literals': {
        const typeName = this.typeName(node, ctxName);
        return `${typeName}.fromWire(${raw} as? String ?: throw BridgeKitDecodeException(${fieldLit}, "${typeName}")) ?: throw BridgeKitDecodeException(${fieldLit}, "${typeName}")`;
      }

      case 'array': {
        const item = (node as ArrayNode).item;
        const itemCtx = `${ctxName}Item`;
        return `(${raw} as? List<*>)?.map { ${this.decodeExpr('it', item, itemCtx, fieldName)} } ?: throw BridgeKitDecodeException(${fieldLit}, "List")`;
      }

      case 'record': {
        const value = (node as RecordNode).value;
        const valueCtx = `${ctxName}Value`;
        return `(${raw} as? Map<*, *>)?.entries?.associate { (k, v) -> k.toString() to ${this.decodeExpr('v', value, valueCtx, fieldName)} } ?: throw BridgeKitDecodeException(${fieldLit}, "Map")`;
      }

      case 'int64':
        return `when (val v = ${raw}) { is String -> v.toLong(); else -> throw BridgeKitDecodeException(${fieldLit}, "Long") }`;

      case 'date':
        return `java.time.Instant.ofEpochMilli(when (val v = ${raw}) { is Number -> v.toLong(); else -> throw BridgeKitDecodeException(${fieldLit}, "Instant") })`;

      case 'binary':
        return `android.util.Base64.decode(${raw} as? String ?: throw BridgeKitDecodeException(${fieldLit}, "ByteArray"), android.util.Base64.NO_WRAP)`;

      case 'enum': {
        const typeName = this.typeName(node, ctxName);
        return `${typeName}.fromWire(when (val v = ${raw}) { is Number -> v.toInt(); else -> throw BridgeKitDecodeException(${fieldLit}, "${typeName}") }) ?: throw BridgeKitDecodeException(${fieldLit}, "${typeName}")`;
      }

      case 'object':
      case 'union':
      case 'oneOf': {
        const typeName = this.registerComposite(node, ctxName);
        return `${this.className}Codecs.decode${typeName}(${raw} as? Map<*, *> ?: throw BridgeKitDecodeException(${fieldLit}, "${typeName}"))`;
      }

      case 'tuple': {
        const typeName = this.registerComposite(node, ctxName);
        return `${this.className}Codecs.decode${typeName}(${raw} as? List<*> ?: throw BridgeKitDecodeException(${fieldLit}, "${typeName}"))`;
      }

      default:
        return raw;
    }
  }

  // ---- composite registration --------------------------------------------

  /**
   * Ensures the composite (object/union) at `ctxName` has its encode<T>/decode<T>
   * functions emitted into the contract codec list, then returns its type name.
   * Idempotent — a composite reached at the same structural position is emitted once.
   */
  private registerComposite(node: SchemaNode, ctxName: string): string {
    const typeName = this.typeName(node, ctxName);
    if (this.registered.has(typeName)) return typeName;
    // Mark BEFORE recursing so a self-referential shape cannot infinite-loop.
    this.registered.add(typeName);

    let fn: string;
    if (node.kind === 'union') {
      fn = this.emitUnionCodec(typeName, node as UnionNode);
    } else if (node.kind === 'tuple') {
      fn = this.emitTupleCodec(typeName, node as TupleNode);
    } else if (node.kind === 'oneOf') {
      fn = this.emitOneOfCodec(typeName, node as OneOfNode);
    } else {
      fn = this.emitObjectCodec(typeName, node as ObjectNode);
    }
    this.register(fn);
    return typeName;
  }

  /**
   * Emits `encode<T>` + `decode<T>` for an object type. Every field is walked
   * through the same `encodeExpr`/`decodeExpr`, so nested composites recurse and
   * register their own codecs. Public so the top-level emitter can register
   * result/params object codecs through the identical path.
   */
  emitObjectCodec(dataClassName: string, objNode: ObjectNode): string {
    if (!this.registered.has(dataClassName)) this.registered.add(dataClassName);
    const encodeLines: string[] = [];
    const decodeLines: string[] = [];

    encodeLines.push(`fun encode${dataClassName}(value: ${dataClassName}): Map<String, Any?> {`);
    encodeLines.push(`    val map = mutableMapOf<String, Any?>()`);
    for (const [fieldName, fieldSchema] of Object.entries(objNode.fields)) {
      const isNullable = fieldSchema.kind === 'optional' || fieldSchema.kind === 'nullable';
      const inner = isNullable ? (fieldSchema as OptionalNode | NullableNode).inner : fieldSchema;
      const fieldCtx = dataClassName + toPascalCase(fieldName);
      const escapedAccess = `value.${escapeKotlinIdentifier(fieldName)}`;
      if (isNullable) {
        encodeLines.push(
          `    ${escapedAccess}?.let { map[${kotlinStringLiteral(fieldName)}] = ${this.encodeExpr('it', inner, fieldCtx)} }`,
        );
      } else {
        encodeLines.push(
          `    map[${kotlinStringLiteral(fieldName)}] = ${this.encodeExpr(escapedAccess, inner, fieldCtx)}`,
        );
      }
    }
    encodeLines.push(`    return map`);
    encodeLines.push(`}`);

    decodeLines.push(
      `fun decode${dataClassName}(raw: Map<*, *>): ${dataClassName} = ${dataClassName}(`,
    );
    for (const [fieldName, fieldSchema] of Object.entries(objNode.fields)) {
      const isNullable = fieldSchema.kind === 'optional' || fieldSchema.kind === 'nullable';
      const inner = isNullable ? (fieldSchema as OptionalNode | NullableNode).inner : fieldSchema;
      const fieldCtx = dataClassName + toPascalCase(fieldName);
      const rawExpr = `raw[${kotlinStringLiteral(fieldName)}]`;
      const escapedParamName = escapeKotlinIdentifier(fieldName);
      const decodeCall = isNullable
        ? `if (${rawExpr} == null) null else ${this.decodeExpr(rawExpr, inner, fieldCtx, fieldName)}`
        : this.decodeExpr(rawExpr, inner, fieldCtx, fieldName);
      decodeLines.push(`    ${escapedParamName} = ${decodeCall},`);
    }
    decodeLines.push(`)`);

    return [...encodeLines, '', ...decodeLines].join('\n');
  }

  /**
   * Emits `encode<T>` + `decode<T>` for a discriminated union (sealed class).
   * Variant fields walk through `encodeExpr`/`decodeExpr`, so a variant field that
   * is itself composite recurses correctly (the legacy emitUnionCodec called
   * encodeFieldValue here, which silently dropped composites — D2 bug).
   */
  emitUnionCodec(sealedName: string, node: UnionNode): string {
    if (!this.registered.has(sealedName)) this.registered.add(sealedName);
    const encodeLines: string[] = [];
    const decodeLines: string[] = [];

    encodeLines.push(
      `fun encode${sealedName}(value: ${sealedName}): Map<String, Any?> = when (value) {`,
    );
    for (const [variantName, variantSchema] of Object.entries(node.variants)) {
      const variantClass = `${sealedName}.${toPascalCase(variantName)}`;
      const fieldEntries = [
        `${kotlinStringLiteral(node.discriminant)} to ${kotlinStringLiteral(variantName)}`,
        ...Object.entries(variantSchema.fields).map(([f, fs]) => {
          const isNullable = fs.kind === 'optional' || fs.kind === 'nullable';
          const inner = isNullable ? (fs as OptionalNode | NullableNode).inner : fs;
          const fieldCtx = sealedName + toPascalCase(variantName) + toPascalCase(f);
          return `${kotlinStringLiteral(f)} to ${this.encodeExpr(`value.${escapeKotlinIdentifier(f)}`, inner, fieldCtx)}`;
        }),
      ];
      encodeLines.push(`    is ${variantClass} -> mapOf(${fieldEntries.join(', ')})`);
    }
    encodeLines.push(`}`);

    decodeLines.push(`fun decode${sealedName}(raw: Map<*, *>): ${sealedName} {`);
    decodeLines.push(
      `    val disc = raw[${kotlinStringLiteral(node.discriminant)}] as? String ?: ""`,
    );
    decodeLines.push(`    return when (disc) {`);
    for (const [variantName, variantSchema] of Object.entries(node.variants)) {
      const variantClass = `${sealedName}.${toPascalCase(variantName)}`;
      const fieldArgs = Object.entries(variantSchema.fields).map(([f, fs]) => {
        const isNullable = fs.kind === 'optional' || fs.kind === 'nullable';
        const inner = isNullable ? (fs as OptionalNode | NullableNode).inner : fs;
        const fieldCtx = sealedName + toPascalCase(variantName) + toPascalCase(f);
        const rawExpr = `raw[${kotlinStringLiteral(f)}]`;
        const decodeCall = isNullable
          ? `if (${rawExpr} == null) null else ${this.decodeExpr(rawExpr, inner, fieldCtx, f)}`
          : this.decodeExpr(rawExpr, inner, fieldCtx, f);
        return `${escapeKotlinIdentifier(f)} = ${decodeCall}`;
      });
      decodeLines.push(
        `        ${kotlinStringLiteral(variantName)} -> ${variantClass}(${fieldArgs.join(', ')})`,
      );
    }
    decodeLines.push(
      `        else -> throw IllegalArgumentException("Unknown ${sealedName} discriminant: $disc")`,
    );
    decodeLines.push(`    }`);
    decodeLines.push(`}`);

    return [...encodeLines, '', ...decodeLines].join('\n');
  }

  /**
   * Emits `encode<T>` + `decode<T>` for a tuple type (positional data class, List wire).
   * encode: value → listOf(encode(v0), encode(v1), ...)
   * decode: List<*> → T(decode(raw[0], item0), decode(raw[1], item1), ...)
   */
  emitTupleCodec(typeName: string, node: TupleNode): string {
    if (!this.registered.has(typeName)) this.registered.add(typeName);
    const encodeLines: string[] = [];
    const decodeLines: string[] = [];

    encodeLines.push(`fun encode${typeName}(value: ${typeName}): List<Any?> {`);
    const encodeItems = node.items.map((item, i) => {
      const itemCtx = `${typeName}V${i}`;
      return `    ${this.encodeExpr(`value.v${i}`, item, itemCtx)}`;
    });
    encodeLines.push(`    return listOf(`);
    for (const item of encodeItems) encodeLines.push(`${item},`);
    encodeLines.push(`    )`);
    encodeLines.push(`}`);

    decodeLines.push(`fun decode${typeName}(raw: List<*>): ${typeName} {`);
    decodeLines.push(
      `    if (raw.size < ${node.items.length}) throw BridgeKitDecodeException("tuple", "${typeName}")`,
    );
    const ctorArgs = node.items.map((item, i) => {
      const itemCtx = `${typeName}V${i}`;
      return `    val v${i} = ${this.decodeExpr(`raw[${i}]`, item, itemCtx, `v${i}`)}`;
    });
    for (const arg of ctorArgs) decodeLines.push(arg);
    const argList = node.items.map((_, i) => `v${i} = v${i}`).join(', ');
    decodeLines.push(`    return ${typeName}(${argList})`);
    decodeLines.push(`}`);

    return [...encodeLines, '', ...decodeLines].join('\n');
  }

  /**
   * Emits `encode<T>` + `decode<T>` for a oneOf (primitive union, sealed class, @t/@v envelope).
   * encode: when (value) { is T.Opt0 -> mapOf("@t" to "<stableTag>", "@v" to ...) }
   * decode: when (raw["@t"] as String) { "<stableTag>" -> T.Opt0(...) }
   */
  emitOneOfCodec(typeName: string, node: OneOfNode): string {
    if (!this.registered.has(typeName)) this.registered.add(typeName);
    const encodeLines: string[] = [];
    const decodeLines: string[] = [];
    const tags = node.tags;
    if (tags === undefined || tags.length !== node.options.length) {
      throw new Error(`[bridgekit] oneOf ${typeName} is missing stable option tags.`);
    }

    encodeLines.push(
      `fun encode${typeName}(value: ${typeName}): Map<String, Any?> = when (value) {`,
    );
    for (let i = 0; i < node.options.length; i++) {
      const opt = node.options[i];
      const optCtx = `${typeName}Opt${i}`;
      const encodeV = this.encodeExpr('value.value', opt, optCtx);
      encodeLines.push(
        `    is ${typeName}.Opt${i} -> mapOf("@t" to ${kotlinStringLiteral(tags[i])}, "@v" to ${encodeV})`,
      );
    }
    encodeLines.push(`}`);

    decodeLines.push(`fun decode${typeName}(raw: Map<*, *>): ${typeName} {`);
    decodeLines.push(
      `    val tag = raw["@t"] as? String ?: throw BridgeKitDecodeException("@t", "${typeName}")`,
    );
    decodeLines.push(`    val v = raw["@v"]`);
    decodeLines.push(`    return when (tag) {`);
    for (let i = 0; i < node.options.length; i++) {
      const opt = node.options[i];
      const optCtx = `${typeName}Opt${i}`;
      const decodeV = this.decodeExpr('v', opt, optCtx, `opt${i}`);
      decodeLines.push(
        `        ${kotlinStringLiteral(tags[i])} -> ${typeName}.Opt${i}(${decodeV})`,
      );
    }
    decodeLines.push(`        else -> throw BridgeKitDecodeException("@t=$tag", "${typeName}")`);
    decodeLines.push(`    }`);
    decodeLines.push(`}`);

    return [...encodeLines, '', ...decodeLines].join('\n');
  }
}
