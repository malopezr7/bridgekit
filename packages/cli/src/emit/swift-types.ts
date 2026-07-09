// emit/swift-types.ts — Swift type emitter.
// Kept < 500 LOC per D9 split rule.

import {
  type ArrayNode,
  type EnumNode,
  hashMember,
  type LiteralsNode,
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

// ---- Swift reserved keywords requiring backtick escaping --------------------

export const SWIFT_HARD_KEYWORDS = new Set([
  'Any',
  'as',
  'associatedtype',
  'break',
  'case',
  'catch',
  'class',
  'continue',
  'default',
  'defer',
  'deinit',
  'do',
  'else',
  'enum',
  'extension',
  'fallthrough',
  'false',
  'fileprivate',
  'for',
  'func',
  'guard',
  'if',
  'import',
  'in',
  'init',
  'inout',
  'internal',
  'is',
  'let',
  'nil',
  'open',
  'operator',
  'precedencegroup',
  'private',
  'protocol',
  'public',
  'repeat',
  'rethrows',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'subscript',
  'super',
  'switch',
  'throw',
  'throws',
  'true',
  'try',
  'typealias',
  'Type',
  'var',
  'where',
  'while',
]);

export function escapeSwiftIdentifier(name: string): string {
  return SWIFT_HARD_KEYWORDS.has(name) ? `\`${name}\`` : name;
}

export function swiftMemberAccess(name: string): string {
  return `.${escapeSwiftIdentifier(name)}`;
}

export function swiftStringLiteral(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    switch (char) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\0':
        out += '\\u{0}';
        break;
      default:
        if (code < 0x20 || code === 0x7f) {
          out += `\\u{${code.toString(16).toUpperCase()}}`;
        } else {
          out += char;
        }
    }
  }
  return `${out}"`;
}

// ---- Enum constant: convert string literal to a valid Swift enum case name --

function toSwiftEnumCase(value: string): string {
  // camelCase from the value string (same rules as Kotlin toEnumConstant but lowercase)
  return value
    .replace(/[-.\s_]+(.)/g, (_, c: string) => (c as string).toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

function validateLiteralsCollisions(values: string[], contextName: string): void {
  const seen = new Map<string, string>();
  for (const v of values) {
    const caseName = toSwiftEnumCase(v);
    if (seen.has(caseName)) {
      throw new Error(
        `Literal collision in ${contextName}: values '${seen.get(caseName)}' and '${v}' ` +
          `both mangle to '${caseName}'. Rename one of them.`,
      );
    }
    seen.set(caseName, v);
  }
}

interface TypeResult {
  typeName: string;
  declarations: string[];
  nullable: boolean;
}

export class SwiftTypeEmitter {
  private readonly className: string;
  private readonly declarations: Map<string, string> = new Map();
  private readonly nameOrigins: Map<string, SchemaNode> = new Map();

  constructor(className: string) {
    this.className = className;
  }

  /**
   * Return the final declaration name for `node` at `candidateName`.
   * Same shape → same name. Different shape → append 4-char structural-hash suffix.
   */
  private allocateName(candidateName: string, node: SchemaNode): string {
    const prior = this.nameOrigins.get(candidateName);
    if (prior === undefined) {
      this.nameOrigins.set(candidateName, node);
      return candidateName;
    }
    if (hashMember(prior) === hashMember(node)) {
      return candidateName;
    }
    const suffix = hashMember(node).slice(0, 4);
    const suffixed = `${candidateName}_${suffix}`;
    if (!this.nameOrigins.has(suffixed)) {
      this.nameOrigins.set(suffixed, node);
    }
    return suffixed;
  }

  emit(node: SchemaNode, contextName: string, nullable = false): TypeResult {
    switch (node.kind) {
      case 'string':
        return { typeName: nullable ? 'String?' : 'String', declarations: [], nullable };
      case 'number':
        return { typeName: nullable ? 'Double?' : 'Double', declarations: [], nullable };
      case 'boolean':
        return { typeName: nullable ? 'Bool?' : 'Bool', declarations: [], nullable };
      case 'void':
        return { typeName: 'Void', declarations: [], nullable: false };
      case 'json':
        return { typeName: 'Any?', declarations: [], nullable: true };

      case 'optional': {
        const inner = this.emit((node as OptionalNode).inner, contextName, true);
        return {
          typeName: inner.typeName.endsWith('?') ? inner.typeName : `${inner.typeName}?`,
          declarations: inner.declarations,
          nullable: true,
        };
      }

      case 'nullable': {
        const inner = this.emit((node as NullableNode).inner, contextName, true);
        return {
          typeName: inner.typeName.endsWith('?') ? inner.typeName : `${inner.typeName}?`,
          declarations: inner.declarations,
          nullable: true,
        };
      }

      case 'array': {
        const item = this.emit((node as ArrayNode).item, `${contextName}Item`);
        return {
          typeName: `[${item.typeName}]`,
          declarations: item.declarations,
          nullable,
        };
      }

      case 'record': {
        const value = this.emit((node as RecordNode).value, `${contextName}Value`);
        return {
          typeName: `[String: ${value.typeName}]`,
          declarations: value.declarations,
          nullable,
        };
      }

      case 'int64':
        return { typeName: nullable ? 'Int64?' : 'Int64', declarations: [], nullable };

      case 'date':
        return { typeName: nullable ? 'Date?' : 'Date', declarations: [], nullable };

      case 'binary':
        return { typeName: nullable ? 'Data?' : 'Data', declarations: [], nullable };

      case 'literals':
        return this.emitLiteralsNode(node as LiteralsNode, contextName, nullable);

      case 'enum':
        return this.emitEnumNode(node as EnumNode, contextName, nullable);

      case 'object':
        return this.emitObjectNode(node as ObjectNode, contextName, nullable);

      case 'union':
        return this.emitUnionNode(node as UnionNode, contextName, nullable);

      case 'tuple':
        return this.emitTupleNode(node as TupleNode, contextName, nullable);

      case 'oneOf':
        return this.emitOneOfNode(node as OneOfNode, contextName, nullable);

      default:
        return { typeName: 'Any?', declarations: [], nullable: true };
    }
  }

  private emitLiteralsNode(lits: LiteralsNode, contextName: string, nullable: boolean): TypeResult {
    const enumName = this.allocateName(toPascalCase(contextName), lits);
    validateLiteralsCollisions(lits.values, `${this.className}.${contextName}`);
    if (!this.declarations.has(enumName)) {
      const cases = lits.values
        .map(
          (v) => `    case ${escapeSwiftIdentifier(toSwiftEnumCase(v))} = ${swiftStringLiteral(v)}`,
        )
        .join('\n');
      this.declarations.set(enumName, [`enum ${enumName}: String {`, cases, `}`].join('\n'));
    }
    return { typeName: nullable ? `${enumName}?` : enumName, declarations: [], nullable };
  }

  private emitEnumNode(enumNode: EnumNode, contextName: string, nullable: boolean): TypeResult {
    const enumName = this.allocateName(toPascalCase(contextName), enumNode);
    if (!this.declarations.has(enumName)) {
      const cases = enumNode.members
        .map((m) => `    case ${escapeSwiftIdentifier(m.name)} = ${m.value}`)
        .join('\n');
      this.declarations.set(enumName, [`enum ${enumName}: Int {`, cases, `}`].join('\n'));
    }
    return { typeName: nullable ? `${enumName}?` : enumName, declarations: [], nullable };
  }

  private emitObjectNode(obj: ObjectNode, contextName: string, nullable: boolean): TypeResult {
    const structName = this.allocateName(toPascalCase(contextName), obj);
    if (!this.declarations.has(structName)) {
      const fields: string[] = [];
      for (const [fieldName, fieldSchema] of Object.entries(obj.fields)) {
        const fieldType = this.emit(fieldSchema, structName + toPascalCase(fieldName));
        const escapedName = escapeSwiftIdentifier(fieldName);
        const defaultPart = fieldType.nullable ? ' = nil' : '';
        fields.push(`    var ${escapedName}: ${fieldType.typeName}${defaultPart}`);
      }
      this.declarations.set(structName, [`struct ${structName} {`, ...fields, `}`].join('\n'));
    }
    return { typeName: nullable ? `${structName}?` : structName, declarations: [], nullable };
  }

  private emitUnionNode(union: UnionNode, contextName: string, nullable: boolean): TypeResult {
    const enumName = this.allocateName(toPascalCase(contextName), union);
    if (!this.declarations.has(enumName)) {
      const cases: string[] = [];
      const structs: string[] = [];

      for (const [variantName, variantSchema] of Object.entries(union.variants)) {
        const variantTypeName = `${enumName}${toPascalCase(variantName)}`;
        // Emit the associated value struct
        const fields: string[] = [];
        for (const [fieldName, fieldSchema] of Object.entries(variantSchema.fields)) {
          const fieldType = this.emit(fieldSchema, variantTypeName + toPascalCase(fieldName));
          const escapedName = escapeSwiftIdentifier(fieldName);
          const defaultPart = fieldType.nullable ? ' = nil' : '';
          fields.push(`    var ${escapedName}: ${fieldType.typeName}${defaultPart}`);
        }
        if (fields.length > 0) {
          structs.push([`struct ${variantTypeName} {`, ...fields, `}`].join('\n'));
          cases.push(`    case ${escapeSwiftIdentifier(variantName)}(${variantTypeName})`);
        } else {
          cases.push(`    case ${escapeSwiftIdentifier(variantName)}`);
        }
      }

      this.declarations.set(enumName, [`enum ${enumName} {`, ...cases, `}`, ...structs].join('\n'));
    }
    return { typeName: nullable ? `${enumName}?` : enumName, declarations: [], nullable };
  }

  private emitTupleNode(tupleNode: TupleNode, contextName: string, nullable: boolean): TypeResult {
    const structName = this.allocateName(toPascalCase(contextName), tupleNode);
    if (!this.declarations.has(structName)) {
      const fields: string[] = [];
      for (let i = 0; i < tupleNode.items.length; i++) {
        const itemType = this.emit(tupleNode.items[i], `${structName}V${i}`);
        fields.push(`    var v${i}: ${itemType.typeName}`);
      }
      this.declarations.set(structName, [`struct ${structName} {`, ...fields, `}`].join('\n'));
    }
    return { typeName: nullable ? `${structName}?` : structName, declarations: [], nullable };
  }

  private emitOneOfNode(oneOfNode: OneOfNode, contextName: string, nullable: boolean): TypeResult {
    const enumName = this.allocateName(toPascalCase(contextName), oneOfNode);
    if (!this.declarations.has(enumName)) {
      const cases: string[] = [];
      for (let i = 0; i < oneOfNode.options.length; i++) {
        const optType = this.emit(oneOfNode.options[i], `${enumName}Opt${i}`);
        cases.push(`    case opt${i}(${optType.typeName})`);
      }
      this.declarations.set(enumName, [`enum ${enumName} {`, ...cases, `}`].join('\n'));
    }
    return { typeName: nullable ? `${enumName}?` : enumName, declarations: [], nullable };
  }

  getDeclarations(): string[] {
    return Array.from(this.declarations.values());
  }
}

// ---- swiftLiteral —  initial state values → Swift literal ------------------

export function swiftLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return swiftStringLiteral(value);
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return `[${(value as unknown[]).map(swiftLiteral).join(', ')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${swiftStringLiteral(k)}: ${swiftLiteral(v)}`)
      .join(', ');
    return `[${entries}]`;
  }
  return 'nil';
}
