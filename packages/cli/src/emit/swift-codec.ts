// emit/swift-codec.ts — Swift codec walker (mirrors CodecWalker from codec.ts).
// Kept < 500 LOC per D9 split rule.

import { schemaNeedsCodec } from './codec.js';
import { escapeSwiftIdentifier, type SwiftTypeEmitter } from './swift-types.js';
import {
  type ArrayNode,
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

// Re-export schemaNeedsCodec — portable, same for Kotlin and Swift.
export { schemaNeedsCodec };

export class SwiftCodecWalker {
  private readonly emitter: SwiftTypeEmitter;
  private readonly className: string;
  private readonly register: (fn: string) => void;
  private readonly registered: Set<string>;

  constructor(
    emitter: SwiftTypeEmitter,
    className: string,
    register: (fn: string) => void,
    registered: Set<string>,
  ) {
    this.emitter = emitter;
    this.className = className;
    this.register = register;
    this.registered = registered;
  }

  private typeName(node: SchemaNode, ctxName: string): string {
    return this.emitter.emit(node, ctxName).typeName.replace(/\?$/, '');
  }

  // ---- boundary idioms -------------------------------------------------------

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

  boundaryDecode(expr: string, node: SchemaNode, ctxName: string): string {
    switch (node.kind) {
      case 'object':
      case 'union':
      case 'oneOf': {
        const typeName = this.registerComposite(node, ctxName);
        return `try ${this.className}Codecs.decode${typeName}(${expr} as! [String: Any?])`;
      }
      case 'tuple': {
        const typeName = this.registerComposite(node, ctxName);
        return `try ${this.className}Codecs.decode${typeName}(${expr} as! [Any?])`;
      }
      case 'literals': {
        const typeName = this.typeName(node, ctxName);
        return `${typeName}(rawValue: ${expr} as? String ?? "") ?? { fatalError("Unknown ${typeName} value: \\(${expr} as Any)") }()`;
      }
      case 'enum': {
        const typeName = this.typeName(node, ctxName);
        return `try (${typeName}(rawValue: Int(exactly: try ((${expr} as? NSNumber) ?? bridgeKitThrow(field: "result", expectedType: "${typeName}"))) ?? bridgeKitThrow(field: "result", expectedType: "${typeName}"))`;
      }
      case 'date':
        return `try Date(timeIntervalSince1970: Double((${expr} as? Int64) ?? Int64(try ((${expr} as? Double) ?? bridgeKitThrow(field: "result", expectedType: "Date")))) / 1000.0)`;
      case 'int64':
        return `try (Int64(exactly: try ((${expr} as? NSNumber) ?? bridgeKitThrow(field: "result", expectedType: "Int64"))) ?? Int64(try ((${expr} as? Double) ?? bridgeKitThrow(field: "result", expectedType: "Int64"))))`;
      case 'binary':
        return `try (Data(base64Encoded: try ((${expr} as? String) ?? bridgeKitThrow(field: "result", expectedType: "Data"))) ?? bridgeKitThrow(field: "result", expectedType: "Data"))`;
      default:
        return this.decodeExpr(expr, node, ctxName, ctxName);
    }
  }

  // ---- ENCODE ----------------------------------------------------------------

  encodeExpr(expr: string, node: SchemaNode, ctxName: string): string {
    switch (node.kind) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'json':
        return expr;
      case 'void':
        return 'nil';

      case 'literals':
        return `${expr}.rawValue`;

      case 'optional':
      case 'nullable': {
        const inner = (node as OptionalNode | NullableNode).inner;
        return `${expr}.map { ${this.encodeExpr('$0', inner, ctxName)} }`;
      }

      case 'array': {
        const item = (node as ArrayNode).item;
        const itemCtx = `${ctxName}Item`;
        return `${expr}.map { ${this.encodeExpr('$0', item, itemCtx)} }`;
      }

      case 'record': {
        const value = (node as RecordNode).value;
        const valueCtx = `${ctxName}Value`;
        return `${expr}.mapValues { ${this.encodeExpr('$0', value, valueCtx)} }`;
      }

      case 'int64':
        return expr;

      case 'date':
        // encode Date → epoch millis (Int64)
        return `Int64(${expr}.timeIntervalSince1970 * 1000)`;

      case 'binary':
        // encode Data → base64 string
        return `${expr}.base64EncodedString()`;

      case 'enum':
        // encode enum → rawValue (Int)
        return `${expr}.rawValue`;

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

  // ---- DECODE ----------------------------------------------------------------

  decodeExpr(raw: string, node: SchemaNode, ctxName: string, fieldName = 'value'): string {
    const fieldLit = JSON.stringify(fieldName);
    switch (node.kind) {
      case 'string':
        return `try ((${raw} as? String) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "String"))`;
      case 'number':
        return `try ((${raw} as? Double) ?? Double(try ((${raw} as? Int) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "Double"))))`;
      case 'boolean':
        return `try ((${raw} as? Bool) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "Bool"))`;
      case 'json':
        return raw;
      case 'void':
        return '()';

      case 'optional':
      case 'nullable': {
        const inner = (node as OptionalNode | NullableNode).inner;
        return `${raw} == nil ? nil : ${this.decodeExpr(raw, inner, ctxName, fieldName)}`;
      }

      case 'literals': {
        const typeName = this.typeName(node, ctxName);
        return `try (${typeName}(rawValue: (${raw} as? String) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "${typeName}")) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "${typeName}"))`;
      }

      case 'array': {
        const item = (node as ArrayNode).item;
        const itemCtx = `${ctxName}Item`;
        const itemExpr = this.decodeExpr('$0', item, itemCtx, fieldName);
        const itemThrows = this.exprThrows(item);
        const mapExpr = itemThrows
          ? `try ((${raw} as? [Any?]) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "Array")).map { ${itemExpr} }`
          : `try ((${raw} as? [Any?]) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "Array")).map { ${itemExpr} }`;
        return mapExpr;
      }

      case 'record': {
        const value = (node as RecordNode).value;
        const valueCtx = `${ctxName}Value`;
        const valExpr = this.decodeExpr('$0.value', value, valueCtx, fieldName);
        const valThrows = this.exprThrows(value);
        const mapExpr = valThrows
          ? `try ((${raw} as? [String: Any?]) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "Dictionary")).map { ($0.key, ${valExpr}) }`
          : `try ((${raw} as? [String: Any?]) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "Dictionary")).map { ($0.key, ${valExpr}) }`;
        return `Dictionary(uniqueKeysWithValues: ${mapExpr})`;
      }

      case 'int64':
        return `try ((${raw} as? Int64) ?? Int64(try ((${raw} as? Double) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "Int64"))))`;

      case 'date':
        return `try Date(timeIntervalSince1970: Double((${raw} as? Int64) ?? Int64(try ((${raw} as? Double) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "Date")))) / 1000.0)`;

      case 'binary':
        return `try (Data(base64Encoded: try ((${raw} as? String) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "Data"))) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "Data"))`;

      case 'enum': {
        const typeName = this.typeName(node, ctxName);
        return `try (${typeName}(rawValue: Int(try ((${raw} as? NSNumber) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "${typeName}")))) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "${typeName}"))`;
      }

      case 'object':
      case 'union':
      case 'oneOf': {
        const typeName = this.registerComposite(node, ctxName);
        return `try ${this.className}Codecs.decode${typeName}(try ((${raw} as? [String: Any?]) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "${typeName}")))`;
      }

      case 'tuple': {
        const typeName = this.registerComposite(node, ctxName);
        return `try ${this.className}Codecs.decode${typeName}(try ((${raw} as? [Any?]) ?? bridgeKitThrow(field: ${fieldLit}, expectedType: "${typeName}")))`;
      }

      default:
        return raw;
    }
  }

  /**
   * Returns true when decodeExpr for this node kind will contain a `try` expression
   * (i.e., bridgeKitThrow or a composite Codecs.decode call). Used by array/record
   * to decide whether the surrounding `.map {}` needs a `try` prefix (rethrows).
   */
  private exprThrows(node: SchemaNode): boolean {
    switch (node.kind) {
      case 'json':
      case 'void':
        return false;
      case 'optional':
      case 'nullable':
        return this.exprThrows((node as OptionalNode | NullableNode).inner);
      default:
        return true;
    }
  }

  // ---- composite registration ------------------------------------------------

  private registerComposite(node: SchemaNode, ctxName: string): string {
    const typeName = this.typeName(node, ctxName);
    if (this.registered.has(typeName)) return typeName;
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

  emitObjectCodec(dataClassName: string, objNode: ObjectNode): string {
    if (!this.registered.has(dataClassName)) this.registered.add(dataClassName);
    const encodeLines: string[] = [];
    const decodeLines: string[] = [];

    encodeLines.push(
      `static func encode${dataClassName}(_ value: ${dataClassName}) -> [String: Any?] {`,
    );
    encodeLines.push(`    var map = [String: Any?]()`);
    for (const [fieldName, fieldSchema] of Object.entries(objNode.fields)) {
      const isNullable = fieldSchema.kind === 'optional' || fieldSchema.kind === 'nullable';
      const inner = isNullable ? (fieldSchema as OptionalNode | NullableNode).inner : fieldSchema;
      const fieldCtx = dataClassName + toPascalCase(fieldName);
      const escapedAccess = `value.${escapeSwiftIdentifier(fieldName)}`;
      if (isNullable) {
        encodeLines.push(
          `    if let v = ${escapedAccess} { map[${JSON.stringify(fieldName)}] = ${this.encodeExpr('v', inner, fieldCtx)} }`,
        );
      } else {
        encodeLines.push(
          `    map[${JSON.stringify(fieldName)}] = ${this.encodeExpr(escapedAccess, inner, fieldCtx)}`,
        );
      }
    }
    encodeLines.push(`    return map`);
    encodeLines.push(`}`);

    decodeLines.push(
      `static func decode${dataClassName}(_ raw: [String: Any?]) throws -> ${dataClassName} {`,
    );
    decodeLines.push(`    return ${dataClassName}(`);
    const fieldDecodes: string[] = [];
    for (const [fieldName, fieldSchema] of Object.entries(objNode.fields)) {
      const isNullable = fieldSchema.kind === 'optional' || fieldSchema.kind === 'nullable';
      const inner = isNullable ? (fieldSchema as OptionalNode | NullableNode).inner : fieldSchema;
      const fieldCtx = dataClassName + toPascalCase(fieldName);
      const rawExpr = `raw[${JSON.stringify(fieldName)}] as Any?`;
      const escapedParamName = escapeSwiftIdentifier(fieldName);
      const decodeCall = isNullable
        ? `raw[${JSON.stringify(fieldName)}] == nil ? nil : (${this.decodeExpr(rawExpr, inner, fieldCtx, fieldName)})`
        : this.decodeExpr(rawExpr, inner, fieldCtx, fieldName);
      fieldDecodes.push(`        ${escapedParamName}: ${decodeCall}`);
    }
    decodeLines.push(fieldDecodes.join(',\n'));
    decodeLines.push(`    )`);
    decodeLines.push(`}`);

    return [...encodeLines, '', ...decodeLines].join('\n');
  }

  emitUnionCodec(enumName: string, node: UnionNode): string {
    if (!this.registered.has(enumName)) this.registered.add(enumName);
    const encodeLines: string[] = [];
    const decodeLines: string[] = [];

    encodeLines.push(`static func encode${enumName}(_ value: ${enumName}) -> [String: Any?] {`);
    encodeLines.push(`    switch value {`);
    for (const [variantName, variantSchema] of Object.entries(node.variants)) {
      const _variantTypeName = `${enumName}${toPascalCase(variantName)}`;
      const hasFields = Object.keys(variantSchema.fields).length > 0;
      if (hasFields) {
        const fieldEntries = [
          `${JSON.stringify(node.discriminant)}: ${JSON.stringify(variantName)}`,
          ...Object.entries(variantSchema.fields).map(([f, fs]) => {
            const isNullable = fs.kind === 'optional' || fs.kind === 'nullable';
            const inner = isNullable ? (fs as OptionalNode | NullableNode).inner : fs;
            const fieldCtx = enumName + toPascalCase(variantName) + toPascalCase(f);
            return `${JSON.stringify(f)}: ${this.encodeExpr(`v.${escapeSwiftIdentifier(f)}`, inner, fieldCtx)}`;
          }),
        ];
        encodeLines.push(`    case .${variantName}(let v): return [${fieldEntries.join(', ')}]`);
      } else {
        encodeLines.push(
          `    case .${variantName}: return [${JSON.stringify(node.discriminant)}: ${JSON.stringify(variantName)}]`,
        );
      }
    }
    encodeLines.push(`    }`);
    encodeLines.push(`}`);

    decodeLines.push(
      `static func decode${enumName}(_ raw: [String: Any?]) throws -> ${enumName} {`,
    );
    decodeLines.push(`    let disc = raw[${JSON.stringify(node.discriminant)}] as? String ?? ""`);
    decodeLines.push(`    switch disc {`);
    for (const [variantName, variantSchema] of Object.entries(node.variants)) {
      const variantTypeName = `${enumName}${toPascalCase(variantName)}`;
      const hasFields = Object.keys(variantSchema.fields).length > 0;
      if (hasFields) {
        const fieldArgs = Object.entries(variantSchema.fields).map(([f, fs]) => {
          const isNullable = fs.kind === 'optional' || fs.kind === 'nullable';
          const inner = isNullable ? (fs as OptionalNode | NullableNode).inner : fs;
          const fieldCtx = enumName + toPascalCase(variantName) + toPascalCase(f);
          const rawExpr = `raw[${JSON.stringify(f)}] as Any?`;
          const decodeCall = isNullable
            ? `raw[${JSON.stringify(f)}] == nil ? nil : (${this.decodeExpr(rawExpr, inner, fieldCtx, f)})`
            : this.decodeExpr(rawExpr, inner, fieldCtx, f);
          return `${escapeSwiftIdentifier(f)}: ${decodeCall}`;
        });
        decodeLines.push(
          `    case ${JSON.stringify(variantName)}: return .${variantName}(try ${variantTypeName}(${fieldArgs.join(', ')}))`,
        );
      } else {
        decodeLines.push(`    case ${JSON.stringify(variantName)}: return .${variantName}`);
      }
    }
    decodeLines.push(
      `    default: throw BridgeKitDecodeError(field: ${JSON.stringify(node.discriminant)}, expectedType: "${enumName}")`,
    );
    decodeLines.push(`    }`);
    decodeLines.push(`}`);

    return [...encodeLines, '', ...decodeLines].join('\n');
  }

  emitTupleCodec(typeName: string, node: TupleNode): string {
    if (!this.registered.has(typeName)) this.registered.add(typeName);
    const encodeLines: string[] = [];
    const decodeLines: string[] = [];

    encodeLines.push(`static func encode${typeName}(_ value: ${typeName}) -> [Any?] {`);
    const encodeItems = node.items.map((item, i) => {
      const itemCtx = `${typeName}V${i}`;
      return `    ${this.encodeExpr(`value.v${i}`, item, itemCtx)}`;
    });
    encodeLines.push(`    return [`);
    for (const item of encodeItems) encodeLines.push(`${item},`);
    encodeLines.push(`    ]`);
    encodeLines.push(`}`);

    decodeLines.push(`static func decode${typeName}(_ raw: [Any?]) throws -> ${typeName} {`);
    decodeLines.push(
      `    guard raw.count >= ${node.items.length} else { throw BridgeKitDecodeError(field: "tuple", expectedType: "${typeName}") }`,
    );
    const ctorArgs = node.items.map((item, i) => {
      const itemCtx = `${typeName}V${i}`;
      return `    let v${i} = ${this.decodeExpr(`raw[${i}]`, item, itemCtx, `v${i}`)}`;
    });
    for (const arg of ctorArgs) decodeLines.push(arg);
    const argList = node.items.map((_, i) => `v${i}: v${i}`).join(', ');
    decodeLines.push(`    return ${typeName}(${argList})`);
    decodeLines.push(`}`);

    return [...encodeLines, '', ...decodeLines].join('\n');
  }

  emitOneOfCodec(typeName: string, node: OneOfNode): string {
    if (!this.registered.has(typeName)) this.registered.add(typeName);
    const encodeLines: string[] = [];
    const decodeLines: string[] = [];

    encodeLines.push(`static func encode${typeName}(_ value: ${typeName}) -> [String: Any?] {`);
    encodeLines.push(`    switch value {`);
    for (let i = 0; i < node.options.length; i++) {
      const opt = node.options[i];
      const optCtx = `${typeName}Opt${i}`;
      const encodeV = this.encodeExpr('v', opt, optCtx);
      encodeLines.push(`    case .opt${i}(let v): return ["@k": ${i}, "@v": ${encodeV}]`);
    }
    encodeLines.push(`    }`);
    encodeLines.push(`}`);

    decodeLines.push(
      `static func decode${typeName}(_ raw: [String: Any?]) throws -> ${typeName} {`,
    );
    decodeLines.push(
      `    guard let k = (raw["@k"] as? NSNumber).map(Int.init) else { throw BridgeKitDecodeError(field: "@k", expectedType: "${typeName}") }`,
    );
    decodeLines.push(`    let v = raw["@v"] as Any?`);
    decodeLines.push(`    switch k {`);
    for (let i = 0; i < node.options.length; i++) {
      const opt = node.options[i];
      const optCtx = `${typeName}Opt${i}`;
      const decodeV = this.decodeExpr('v', opt, optCtx, `opt${i}`);
      decodeLines.push(`    case ${i}: return .opt${i}(${decodeV})`);
    }
    decodeLines.push(
      `    default: throw BridgeKitDecodeError(field: "@k=\\(k)", expectedType: "${typeName}")`,
    );
    decodeLines.push(`    }`);
    decodeLines.push(`}`);

    return [...encodeLines, '', ...decodeLines].join('\n');
  }
}
