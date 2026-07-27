// emit/swift-codec.ts — Swift codec walker (mirrors CodecWalker from codec.ts).
// Kept < 500 LOC per D9 split rule.

import { schemaNeedsCodec } from './codec.js';
import {
  escapeSwiftIdentifier,
  type SwiftTypeEmitter,
  swiftMemberAccess,
  swiftStringLiteral,
} from './swift-types.js';
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
        return `try ${this.className}Codecs.decode${typeName}(try ((${expr} as? [String: Any?]) ?? bridgeKitThrow(path: "result", expectedType: "${typeName}", actualValue: ${expr})), path: "result")`;
      }
      case 'tuple': {
        const typeName = this.registerComposite(node, ctxName);
        return `try ${this.className}Codecs.decode${typeName}(try ((${expr} as? [Any?]) ?? bridgeKitThrow(path: "result", expectedType: "${typeName}", actualValue: ${expr})), path: "result")`;
      }
      case 'literals': {
        const typeName = this.typeName(node, ctxName);
        return `try { () throws -> ${typeName} in
            guard let rawValue = ${expr} as? String else { throw BridgeKitDecodeError(path: "result", expectedType: "${typeName}", actualValue: ${expr}) }
            guard let value = ${typeName}(rawValue: rawValue) else { throw BridgeKitDecodeError(path: "result", expectedType: "${typeName}", actualValue: rawValue) }
            return value
        }()`;
      }
      case 'enum': {
        const typeName = this.typeName(node, ctxName);
        return `try { () throws -> ${typeName} in
            guard let number = ${expr} as? NSNumber else { throw BridgeKitDecodeError(path: "result", expectedType: "${typeName}", actualValue: ${expr}) }
            guard let rawValue = Int(exactly: number) else { throw BridgeKitDecodeError(path: "result", expectedType: "${typeName}", actualValue: number) }
            guard let value = ${typeName}(rawValue: rawValue) else { throw BridgeKitDecodeError(path: "result", expectedType: "${typeName}", actualValue: rawValue) }
            return value
        }()`;
      }
      case 'date':
        return `try Date(timeIntervalSince1970: Double((${expr} as? Int64) ?? Int64(try ((${expr} as? Double) ?? bridgeKitThrow(path: "result", expectedType: "Date", actualValue: ${expr})))) / 1000.0)`;
      case 'int64':
        return `try Int64((${expr} as? String) ?? bridgeKitThrow(path: "result", expectedType: "Int64", actualValue: ${expr})) ?? bridgeKitThrow(path: "result", expectedType: "Int64", actualValue: ${expr})`;
      case 'binary':
        return `try (Data(base64Encoded: try ((${expr} as? String) ?? bridgeKitThrow(path: "result", expectedType: "Data", actualValue: ${expr}))) ?? bridgeKitThrow(path: "result", expectedType: "Data", actualValue: ${expr}))`;
      default:
        return this.decodeExpr(expr, node, ctxName, 'result');
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
        return `String(${expr})`;

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
    return this.decodeExprAtPath(raw, node, ctxName, swiftStringLiteral(fieldName));
  }

  private decodeExprAtPath(
    raw: string,
    node: SchemaNode,
    ctxName: string,
    pathExpr: string,
  ): string {
    const decodeFailure = (expectedType: string, actualValue = raw): string =>
      `bridgeKitThrow(path: ${pathExpr}, expectedType: "${expectedType}", actualValue: ${actualValue})`;
    switch (node.kind) {
      case 'string':
        return `try ((${raw} as? String) ?? ${decodeFailure('String')})`;
      case 'number':
        return `try ((${raw} as? Double) ?? Double(try ((${raw} as? Int) ?? ${decodeFailure('Double')})))`;
      case 'boolean':
        return `try ((${raw} as? Bool) ?? ${decodeFailure('Bool')})`;
      case 'json':
        return raw;
      case 'void':
        return '()';

      case 'optional':
      case 'nullable': {
        const inner = (node as OptionalNode | NullableNode).inner;
        return `${raw} == nil ? nil : ${this.decodeExprAtPath(raw, inner, ctxName, pathExpr)}`;
      }

      case 'literals': {
        const typeName = this.typeName(node, ctxName);
        return `try (${typeName}(rawValue: (${raw} as? String) ?? ${decodeFailure(typeName)}) ?? ${decodeFailure(typeName)})`;
      }

      case 'array': {
        const item = (node as ArrayNode).item;
        const itemCtx = `${ctxName}Item`;
        const itemExpr = this.decodeExprAtPath(
          'item',
          item,
          itemCtx,
          `(${pathExpr}) + "[\\(index)]"`,
        );
        return `try ((${raw} as? [Any?]) ?? ${decodeFailure('Array')}).enumerated().map { index, item in ${itemExpr} }`;
      }

      case 'record': {
        const value = (node as RecordNode).value;
        const valueCtx = `${ctxName}Value`;
        const valExpr = this.decodeExprAtPath(
          'entry.value',
          value,
          valueCtx,
          `(${pathExpr}) + "." + entry.key`,
        );
        const mapExpr = `try ((${raw} as? [String: Any?]) ?? ${decodeFailure('Dictionary')}).map { entry in (entry.key, ${valExpr}) }`;
        return `Dictionary(uniqueKeysWithValues: ${mapExpr})`;
      }

      case 'int64':
        return `try Int64((${raw} as? String) ?? ${decodeFailure('Int64')}) ?? ${decodeFailure('Int64')}`;

      case 'date':
        return `try Date(timeIntervalSince1970: Double((${raw} as? Int64) ?? Int64(try ((${raw} as? Double) ?? ${decodeFailure('Date')}))) / 1000.0)`;

      case 'binary':
        return `try (Data(base64Encoded: try ((${raw} as? String) ?? ${decodeFailure('Data')})) ?? ${decodeFailure('Data')})`;

      case 'enum': {
        const typeName = this.typeName(node, ctxName);
        return `try (${typeName}(rawValue: Int(try ((${raw} as? NSNumber) ?? ${decodeFailure(typeName)}))) ?? ${decodeFailure(typeName)})`;
      }

      case 'object':
      case 'union':
      case 'oneOf': {
        const typeName = this.registerComposite(node, ctxName);
        return `try ${this.className}Codecs.decode${typeName}(try ((${raw} as? [String: Any?]) ?? ${decodeFailure(typeName)}), path: ${pathExpr})`;
      }

      case 'tuple': {
        const typeName = this.registerComposite(node, ctxName);
        return `try ${this.className}Codecs.decode${typeName}(try ((${raw} as? [Any?]) ?? ${decodeFailure(typeName)}), path: ${pathExpr})`;
      }

      default:
        return raw;
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
          `    if let v = ${escapedAccess} { map[${swiftStringLiteral(fieldName)}] = ${this.encodeExpr('v', inner, fieldCtx)} }`,
        );
      } else {
        encodeLines.push(
          `    map[${swiftStringLiteral(fieldName)}] = ${this.encodeExpr(escapedAccess, inner, fieldCtx)}`,
        );
      }
    }
    encodeLines.push(`    return map`);
    encodeLines.push(`}`);

    decodeLines.push(
      `static func decode${dataClassName}(_ raw: [String: Any?], path: String = "") throws -> ${dataClassName} {`,
    );
    decodeLines.push(`    return ${dataClassName}(`);
    const fieldDecodes: string[] = [];
    for (const [fieldName, fieldSchema] of Object.entries(objNode.fields)) {
      const isNullable = fieldSchema.kind === 'optional' || fieldSchema.kind === 'nullable';
      const inner = isNullable ? (fieldSchema as OptionalNode | NullableNode).inner : fieldSchema;
      const fieldCtx = dataClassName + toPascalCase(fieldName);
      const rawExpr = `raw[${swiftStringLiteral(fieldName)}] as Any?`;
      const fieldPath = `path.isEmpty ? ${swiftStringLiteral(fieldName)} : path + ${swiftStringLiteral(`.${fieldName}`)}`;
      const escapedParamName = escapeSwiftIdentifier(fieldName);
      const decodeCall = isNullable
        ? `raw[${swiftStringLiteral(fieldName)}] == nil ? nil : (${this.decodeExprAtPath(rawExpr, inner, fieldCtx, fieldPath)})`
        : this.decodeExprAtPath(rawExpr, inner, fieldCtx, fieldPath);
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
          `${swiftStringLiteral(node.discriminant)}: ${swiftStringLiteral(variantName)}`,
          ...Object.entries(variantSchema.fields).map(([f, fs]) => {
            const isNullable = fs.kind === 'optional' || fs.kind === 'nullable';
            const inner = isNullable ? (fs as OptionalNode | NullableNode).inner : fs;
            const fieldCtx = enumName + toPascalCase(variantName) + toPascalCase(f);
            return `${swiftStringLiteral(f)}: ${this.encodeExpr(`v.${escapeSwiftIdentifier(f)}`, inner, fieldCtx)}`;
          }),
        ];
        encodeLines.push(
          `    case ${swiftMemberAccess(variantName)}(let v): return [${fieldEntries.join(', ')}]`,
        );
      } else {
        encodeLines.push(
          `    case ${swiftMemberAccess(variantName)}: return [${swiftStringLiteral(node.discriminant)}: ${swiftStringLiteral(variantName)}]`,
        );
      }
    }
    encodeLines.push(`    }`);
    encodeLines.push(`}`);

    decodeLines.push(
      `static func decode${enumName}(_ raw: [String: Any?], path: String = "") throws -> ${enumName} {`,
    );
    decodeLines.push(
      `    let disc = raw[${swiftStringLiteral(node.discriminant)}] as? String ?? ""`,
    );
    decodeLines.push(`    switch disc {`);
    for (const [variantName, variantSchema] of Object.entries(node.variants)) {
      const variantTypeName = `${enumName}${toPascalCase(variantName)}`;
      const hasFields = Object.keys(variantSchema.fields).length > 0;
      if (hasFields) {
        const fieldArgs = Object.entries(variantSchema.fields).map(([f, fs]) => {
          const isNullable = fs.kind === 'optional' || fs.kind === 'nullable';
          const inner = isNullable ? (fs as OptionalNode | NullableNode).inner : fs;
          const fieldCtx = enumName + toPascalCase(variantName) + toPascalCase(f);
          const rawExpr = `raw[${swiftStringLiteral(f)}] as Any?`;
          const fieldPath = `path.isEmpty ? ${swiftStringLiteral(f)} : path + ${swiftStringLiteral(`.${f}`)}`;
          const decodeCall = isNullable
            ? `raw[${swiftStringLiteral(f)}] == nil ? nil : (${this.decodeExprAtPath(rawExpr, inner, fieldCtx, fieldPath)})`
            : this.decodeExprAtPath(rawExpr, inner, fieldCtx, fieldPath);
          return `${escapeSwiftIdentifier(f)}: ${decodeCall}`;
        });
        decodeLines.push(
          `    case ${swiftStringLiteral(variantName)}: return ${swiftMemberAccess(variantName)}(try ${variantTypeName}(${fieldArgs.join(', ')}))`,
        );
      } else {
        decodeLines.push(
          `    case ${swiftStringLiteral(variantName)}: return ${swiftMemberAccess(variantName)}`,
        );
      }
    }
    decodeLines.push(
      `    default: throw BridgeKitDecodeError(path: path.isEmpty ? ${swiftStringLiteral(node.discriminant)} : path + ${swiftStringLiteral(`.${node.discriminant}`)}, expectedType: "${enumName}", actualValue: raw[${swiftStringLiteral(node.discriminant)}] as Any?)`,
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

    decodeLines.push(
      `static func decode${typeName}(_ raw: [Any?], path: String = "") throws -> ${typeName} {`,
    );
    decodeLines.push(
      `    guard raw.count >= ${node.items.length} else { throw BridgeKitDecodeError(path: path.isEmpty ? "tuple" : path, expectedType: "${typeName}", actualValue: raw) }`,
    );
    const ctorArgs = node.items.map((item, i) => {
      const itemCtx = `${typeName}V${i}`;
      const itemPath = `path.isEmpty ? "[${i}]" : path + "[${i}]"`;
      return `    let v${i} = ${this.decodeExprAtPath(`raw[${i}]`, item, itemCtx, itemPath)}`;
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
    const tags = node.tags;
    if (tags === undefined || tags.length !== node.options.length) {
      throw new Error(`[bridgekit] oneOf ${typeName} is missing stable option tags.`);
    }

    encodeLines.push(`static func encode${typeName}(_ value: ${typeName}) -> [String: Any?] {`);
    encodeLines.push(`    switch value {`);
    for (let i = 0; i < node.options.length; i++) {
      const opt = node.options[i];
      const optCtx = `${typeName}Opt${i}`;
      const encodeV = this.encodeExpr('v', opt, optCtx);
      encodeLines.push(
        `    case .opt${i}(let v): return ["@t": ${swiftStringLiteral(tags[i])}, "@v": ${encodeV}]`,
      );
    }
    encodeLines.push(`    }`);
    encodeLines.push(`}`);

    decodeLines.push(
      `static func decode${typeName}(_ raw: [String: Any?], path: String = "") throws -> ${typeName} {`,
    );
    decodeLines.push(
      `    guard let tag = raw["@t"] as? String else { throw BridgeKitDecodeError(path: path.isEmpty ? "@t" : path + ".@t", expectedType: "${typeName}", actualValue: raw["@t"] as Any?) }`,
    );
    decodeLines.push(`    let v = raw["@v"] as Any?`);
    decodeLines.push(`    switch tag {`);
    for (let i = 0; i < node.options.length; i++) {
      const opt = node.options[i];
      const optCtx = `${typeName}Opt${i}`;
      const optPath = `path.isEmpty ? "opt${i}" : path + ".opt${i}"`;
      const decodeV = this.decodeExprAtPath('v', opt, optCtx, optPath);
      decodeLines.push(`    case ${swiftStringLiteral(tags[i])}: return .opt${i}(${decodeV})`);
    }
    decodeLines.push(
      `    default: throw BridgeKitDecodeError(path: path.isEmpty ? "@t" : path + ".@t", expectedType: "${typeName}", actualValue: tag)`,
    );
    decodeLines.push(`    }`);
    decodeLines.push(`}`);

    return [...encodeLines, '', ...decodeLines].join('\n');
  }
}
