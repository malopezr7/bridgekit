// emit/types.ts — schema node shapes, identifier helpers, Kotlin type emitter.

import { type AnySchema, encode, stableHash } from '@malopezr7/bridgekit/contract';

import { CliError } from '../cliError.js';

export interface SchemaNode {
  kind: string;
}

export interface ObjectNode extends SchemaNode {
  kind: 'object';
  fields: Record<string, SchemaNode>;
}

export interface ArrayNode extends SchemaNode {
  kind: 'array';
  item: SchemaNode;
}

export interface RecordNode extends SchemaNode {
  kind: 'record';
  value: SchemaNode;
}

export interface OptionalNode extends SchemaNode {
  kind: 'optional';
  inner: SchemaNode;
}

export interface NullableNode extends SchemaNode {
  kind: 'nullable';
  inner: SchemaNode;
}

export interface LiteralsNode extends SchemaNode {
  kind: 'literals';
  values: string[];
}

export interface UnionNode extends SchemaNode {
  kind: 'union';
  discriminant: string;
  variants: Record<string, ObjectNode>;
}

export interface Int64Node extends SchemaNode {
  kind: 'int64';
}

export interface DateNode extends SchemaNode {
  kind: 'date';
}

export interface BinaryNode extends SchemaNode {
  kind: 'binary';
}

export interface EnumMember {
  name: string;
  value: number;
}

export interface EnumNode extends SchemaNode {
  kind: 'enum';
  members: EnumMember[];
}

export interface TupleNode extends SchemaNode {
  kind: 'tuple';
  items: SchemaNode[];
}

export interface OneOfNode extends SchemaNode {
  kind: 'oneOf';
  options: SchemaNode[];
  tags?: readonly string[];
}

// ---- identifier helpers ----------------------------------------------------

export function contractIdToClassName(id: string): string {
  // e.g. 'connect.host' → 'ConnectHost'
  return id
    .split('.')
    .map((seg) =>
      seg
        .replace(/-(.)/g, (_, c: string) => (c as string).toUpperCase())
        .replace(/^(.)/, (c: string) => c.toUpperCase()),
    )
    .join('');
}

export function contractIdToPackage(id: string, override?: string): string {
  if (override) return override;
  // 'connect.host' → 'com.bridgekit.contracts.connect.host'
  // dashes stripped, dots preserved
  const sanitized = id
    .split('.')
    .map((seg) => seg.replace(/-/g, '').toLowerCase())
    .join('.');
  return `com.bridgekit.contracts.${sanitized}`;
}

// Kotlin hard-reserved words — require backtick-escaping as field/param names.
const KOTLIN_HARD_KEYWORDS = new Set([
  'as',
  'break',
  'class',
  'continue',
  'do',
  'else',
  'false',
  'for',
  'fun',
  'if',
  'in',
  'interface',
  'is',
  'null',
  'object',
  'package',
  'return',
  'super',
  'this',
  'throw',
  'true',
  'try',
  'typealias',
  'typeof',
  'val',
  'var',
  'when',
  'while',
]);

export function escapeKotlinIdentifier(name: string): string {
  if (KOTLIN_HARD_KEYWORDS.has(name) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return `\`${name}\``;
  }
  return name;
}

export function toKotlinMemberName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new CliError(
      `Member name '${name}' is not a valid Kotlin identifier. ` +
        `Rename it in the contract to use only letters, digits, and underscores.`,
    );
  }
  return escapeKotlinIdentifier(name);
}

export function kotlinStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/\$/g, '\\$');
}

function toEnumConstant(value: string): string {
  return value
    .replace(/[-.\s]/g, '_')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toUpperCase();
}

function validateLiteralsCollisions(values: string[], contextName: string): void {
  const seen = new Map<string, string>();
  for (const v of values) {
    const constant = toEnumConstant(v);
    if (seen.has(constant)) {
      throw new CliError(
        `Literal collision in ${contextName}: values '${seen.get(constant)}' and '${v}' ` +
          `both mangle to '${constant}'. Rename one of them.`,
      );
    }
    seen.set(constant, v);
  }
}

export function toPascalCase(name: string): string {
  return name
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

// ---- Kotlin type emission --------------------------------------------------

interface TypeResult {
  typeName: string;
  declarations: string[];
  nullable: boolean;
}

export class KotlinTypeEmitter {
  private readonly className: string;
  private readonly declarations: Map<string, string> = new Map();
  /**
   * Track which SchemaNode each declaration name was first registered for.
   * Used by allocateName() to detect collisions (same PascalCase, different structure).
   */
  private readonly nameOrigins: Map<string, SchemaNode> = new Map();

  constructor(className: string) {
    this.className = className;
  }

  /**
   * Return the final declaration name to use for `node` at `candidateName`.
   *
   * - Same shape (structural equality via hashMember) → same name (dedup intact).
   * - Different shape same name → append a 4-char structural-hash suffix.
   *   This guarantees distinct identifiers without breaking same-shape dedup.
   */
  private allocateName(candidateName: string, node: SchemaNode): string {
    const prior = this.nameOrigins.get(candidateName);
    if (prior === undefined) {
      // First registration: claim the name.
      this.nameOrigins.set(candidateName, node);
      return candidateName;
    }
    // Name already claimed — check structural identity.
    if (hashMember(prior) === hashMember(node)) {
      // Same structure → reuse name (correct dedup, no suffix needed).
      return candidateName;
    }
    // Different structure → suffix with this node's structural hash (4 chars).
    const suffix = hashMember(node).slice(0, 4);
    const suffixed = `${candidateName}_${suffix}`;
    // Register suffixed name if not already claimed.
    if (!this.nameOrigins.has(suffixed)) {
      this.nameOrigins.set(suffixed, node);
    }
    return suffixed;
  }

  emit(node: SchemaNode, contextName: string, nullable = false): TypeResult {
    const decls: string[] = [];

    switch (node.kind) {
      case 'string':
        return { typeName: nullable ? 'String?' : 'String', declarations: [], nullable };
      case 'number':
        return { typeName: nullable ? 'Double?' : 'Double', declarations: [], nullable };
      case 'boolean':
        return { typeName: nullable ? 'Boolean?' : 'Boolean', declarations: [], nullable };
      case 'void':
        return { typeName: 'Unit', declarations: [], nullable: false };
      case 'json':
        return { typeName: nullable ? 'Any?' : 'Any?', declarations: [], nullable: true };

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
          typeName: `List<${item.typeName}>`,
          declarations: item.declarations,
          nullable,
        };
      }

      case 'record': {
        const value = this.emit((node as RecordNode).value, `${contextName}Value`);
        return {
          typeName: `Map<String, ${value.typeName}>`,
          declarations: value.declarations,
          nullable,
        };
      }

      case 'literals': {
        const lits = node as LiteralsNode;
        const enumName = this.allocateName(toPascalCase(contextName), node);
        validateLiteralsCollisions(lits.values, `${this.className}.${contextName}`);
        if (!this.declarations.has(enumName)) {
          const constants = lits.values
            .map((v) => {
              const wireValue = kotlinStringLiteral(v);
              return `    /** Wire value: ${wireValue} */\n    ${toEnumConstant(v)}(${wireValue})`;
            })
            .join(',\n');
          const enumDecl = [
            `enum class ${enumName}(val wireValue: String) {`,
            `${constants};`,
            '',
            `    companion object {`,
            `        /** Decode a wire value, returning null for unknown values. */`,
            `        fun fromWire(value: String): ${enumName}? = values().find { it.wireValue == value }`,
            `    }`,
            `}`,
          ].join('\n');
          this.declarations.set(enumName, enumDecl);
        }
        return {
          typeName: nullable ? `${enumName}?` : enumName,
          declarations: decls,
          nullable,
        };
      }

      case 'object': {
        const obj = node as ObjectNode;
        const dataClassName = this.allocateName(toPascalCase(contextName), node);
        if (!this.declarations.has(dataClassName)) {
          const fields: string[] = [];
          const nestedDecls: string[] = [];
          for (const [fieldName, fieldSchema] of Object.entries(obj.fields)) {
            const fieldType = this.emit(fieldSchema, dataClassName + toPascalCase(fieldName));
            nestedDecls.push(...fieldType.declarations);
            const defaultPart = fieldType.nullable ? ' = null' : '';
            const escapedName = escapeKotlinIdentifier(fieldName);
            fields.push(`    val ${escapedName}: ${fieldType.typeName}${defaultPart}`);
          }
          const dataDecl = [
            `data class ${dataClassName}(`,
            fields.join(',\n'),
            `)`,
            ...nestedDecls,
          ].join('\n');
          this.declarations.set(dataClassName, dataDecl);
        }
        return {
          typeName: nullable ? `${dataClassName}?` : dataClassName,
          declarations: decls,
          nullable,
        };
      }

      case 'union': {
        const union = node as UnionNode;
        const sealedName = this.allocateName(toPascalCase(contextName), node);
        if (!this.declarations.has(sealedName)) {
          const variantDecls: string[] = [];
          const variantBodies: string[] = [];

          for (const [variantName, variantSchema] of Object.entries(union.variants)) {
            const variantClassName = toPascalCase(variantName);
            const fields: string[] = [
              `        override val ${escapeKotlinIdentifier(union.discriminant)}: String = ${kotlinStringLiteral(variantName)}`,
            ];
            for (const [fieldName, fieldSchema] of Object.entries(variantSchema.fields)) {
              const fieldType = this.emit(
                fieldSchema,
                sealedName + variantClassName + toPascalCase(fieldName),
              );
              variantDecls.push(...fieldType.declarations);
              const defaultPart = fieldType.nullable ? ' = null' : '';
              const escapedFieldName = escapeKotlinIdentifier(fieldName);
              fields.push(`        val ${escapedFieldName}: ${fieldType.typeName}${defaultPart}`);
            }
            variantBodies.push(
              `    data class ${variantClassName}(\n${fields.join(',\n')}\n    ) : ${sealedName}()`,
            );
          }

          const sealedDecl = [
            `sealed class ${sealedName} {`,
            `    abstract val ${escapeKotlinIdentifier(union.discriminant)}: String`,
            ...variantBodies,
            ...variantDecls.map((d) =>
              d
                .split('\n')
                .map((l) => `    ${l}`)
                .join('\n'),
            ),
            `}`,
          ].join('\n');
          this.declarations.set(sealedName, sealedDecl);
        }
        return {
          typeName: nullable ? `${sealedName}?` : sealedName,
          declarations: decls,
          nullable,
        };
      }

      case 'int64':
        return { typeName: nullable ? 'Long?' : 'Long', declarations: [], nullable };

      case 'date':
        return { typeName: nullable ? 'Instant?' : 'Instant', declarations: [], nullable };

      case 'binary':
        return { typeName: nullable ? 'ByteArray?' : 'ByteArray', declarations: [], nullable };

      case 'enum':
        return this.emitEnumNode(node as EnumNode, contextName, nullable);

      case 'tuple':
        return this.emitTupleNode(node as TupleNode, contextName, nullable);

      case 'oneOf':
        return this.emitOneOfNode(node as OneOfNode, contextName, nullable);

      default:
        return { typeName: 'Any?', declarations: [], nullable: true };
    }
  }

  private emitEnumNode(enumNode: EnumNode, contextName: string, nullable: boolean): TypeResult {
    const enumName = this.allocateName(toPascalCase(contextName), enumNode);
    if (!this.declarations.has(enumName)) {
      const constants = enumNode.members
        .map((m) => `    ${escapeKotlinIdentifier(m.name)}(${m.value})`)
        .join(',\n');
      const fromWireLogic = enumNode.members
        .map((m) => `            ${m.value} -> ${escapeKotlinIdentifier(m.name)}`)
        .join('\n');
      this.declarations.set(
        enumName,
        [
          `enum class ${enumName}(val wireValue: Int) {`,
          `${constants};`,
          `    companion object {`,
          `        fun fromWire(value: Int): ${enumName}? = when (value) {`,
          `${fromWireLogic}`,
          `            else -> null`,
          `        }`,
          `    }`,
          `}`,
        ].join('\n'),
      );
    }
    return { typeName: nullable ? `${enumName}?` : enumName, declarations: [], nullable };
  }

  private emitTupleNode(tupleNode: TupleNode, contextName: string, nullable: boolean): TypeResult {
    const dataClassName = this.allocateName(toPascalCase(contextName), tupleNode);
    if (!this.declarations.has(dataClassName)) {
      const fields: string[] = [];
      const nestedDecls: string[] = [];
      for (let i = 0; i < tupleNode.items.length; i++) {
        const itemType = this.emit(tupleNode.items[i], `${dataClassName}V${i}`);
        nestedDecls.push(...itemType.declarations);
        fields.push(`    val v${i}: ${itemType.typeName}`);
      }
      this.declarations.set(
        dataClassName,
        [`data class ${dataClassName}(`, fields.join(',\n'), `)`, ...nestedDecls].join('\n'),
      );
    }
    return { typeName: nullable ? `${dataClassName}?` : dataClassName, declarations: [], nullable };
  }

  private emitOneOfNode(oneOfNode: OneOfNode, contextName: string, nullable: boolean): TypeResult {
    const sealedName = this.allocateName(toPascalCase(contextName), oneOfNode);
    if (!this.declarations.has(sealedName)) {
      const variantBodies: string[] = [];
      const nestedDecls: string[] = [];
      for (let i = 0; i < oneOfNode.options.length; i++) {
        const optType = this.emit(oneOfNode.options[i], `${sealedName}Opt${i}`);
        nestedDecls.push(...optType.declarations);
        variantBodies.push(
          `    data class Opt${i}(val value: ${optType.typeName}): ${sealedName}()`,
        );
      }
      this.declarations.set(
        sealedName,
        [
          `sealed class ${sealedName} {`,
          ...variantBodies,
          ...nestedDecls.map((d) =>
            d
              .split('\n')
              .map((l) => `    ${l}`)
              .join('\n'),
          ),
          `}`,
        ].join('\n'),
      );
    }
    return { typeName: nullable ? `${sealedName}?` : sealedName, declarations: [], nullable };
  }

  getDeclarations(): string[] {
    return Array.from(this.declarations.values());
  }
}

export function hashMember(value: unknown): string {
  return stableHash(value);
}

export function kotlinLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return `${value}L`;
  if (typeof value === 'string') return kotlinStringLiteral(value);
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return `listOf(${(value as unknown[]).map(kotlinLiteral).join(', ')})`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${kotlinStringLiteral(k)} to ${kotlinLiteral(v)}`)
      .join(', ');
    return `mapOf(${entries})`;
  }
  return 'null';
}

export function kotlinLiteralForSchema(value: unknown, schema: SchemaNode): string {
  return kotlinLiteral(encode(schema as AnySchema, value));
}
