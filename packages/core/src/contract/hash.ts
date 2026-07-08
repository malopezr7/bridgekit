// ---------------------------------------------------------------------------
// Stable hash — FNV-1a 32-bit, no node:crypto (must run in RN/Hermes)
// Recursively sorts object keys before stringifying for determinism.
// ---------------------------------------------------------------------------

import type {
  ContractDescriptor,
  MethodDescriptor,
  StateDescriptor,
  StreamDescriptor,
} from './contract';
import type { AnySchema } from './schema';

// ---- stable stringify -----------------------------------------------------

function sortedStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.getTime());
  if (Array.isArray(value)) {
    return `[${value.map(sortedStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedStringify(obj[k])}`);
    return `{${sorted.join(',')}}`;
  }
  return JSON.stringify(value);
}

type HashableRecord = Record<string, unknown>;
type ProjectedOneOfOption = { readonly tag: string; readonly schema: HashableRecord };

function withDefined(entries: [string, unknown][]): HashableRecord {
  const result: HashableRecord = {};
  for (const [key, value] of entries) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function isRecord(value: unknown): value is HashableRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContractDescriptor(value: unknown): value is ContractDescriptor {
  return isRecord(value) && value.$type === 'com.bridgekit.contract';
}

function tagProjectedSchema(projected: HashableRecord): string {
  return `${projected.kind as string}:${hash8hex(sortedStringify(projected))}`;
}

function projectOneOfOptions(options: readonly AnySchema[]): readonly ProjectedOneOfOption[] {
  return options
    .map((option) => {
      const projected = projectSchema(option);
      return { tag: tagProjectedSchema(projected), schema: projected };
    })
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

const MEMBER_DESCRIPTOR_KINDS = new Set(['fire', 'query', 'querySync', 'stream', 'state']);

function isMemberDescriptor(
  value: unknown,
): value is MethodDescriptor | StreamDescriptor | StateDescriptor {
  return isRecord(value) && MEMBER_DESCRIPTOR_KINDS.has(value.kind as string);
}

function projectSchema(schema: AnySchema | HashableRecord): HashableRecord {
  switch (schema.kind) {
    case 'object':
      return withDefined([
        ['kind', schema.kind],
        ['fields', projectSchemaRecord((schema as { fields: Record<string, AnySchema> }).fields)],
      ]);
    case 'array':
      return withDefined([
        ['kind', schema.kind],
        ['item', projectSchema((schema as { item: AnySchema }).item)],
      ]);
    case 'record':
      return withDefined([
        ['kind', schema.kind],
        ['value', projectSchema((schema as { value: AnySchema }).value)],
      ]);
    case 'optional':
    case 'nullable':
      return withDefined([
        ['kind', schema.kind],
        ['inner', projectSchema((schema as { inner: AnySchema }).inner)],
      ]);
    case 'union':
      return withDefined([
        ['kind', schema.kind],
        ['discriminant', (schema as { discriminant: string }).discriminant],
        [
          'variants',
          projectSchemaRecord((schema as { variants: Record<string, AnySchema> }).variants),
        ],
      ]);
    case 'literals':
      return withDefined([
        ['kind', schema.kind],
        ['values', (schema as { values: readonly unknown[] }).values],
      ]);
    case 'enum':
      return withDefined([
        ['kind', schema.kind],
        ['members', (schema as { members: readonly unknown[] }).members],
      ]);
    case 'tuple':
      return withDefined([
        ['kind', schema.kind],
        ['items', (schema as { items: readonly AnySchema[] }).items.map(projectSchema)],
      ]);
    case 'oneOf': {
      const projectedOptions = projectOneOfOptions(
        (schema as { options: readonly AnySchema[] }).options,
      );
      return withDefined([
        ['kind', schema.kind],
        ['options', projectedOptions.map((option) => option.schema)],
        ['tags', projectedOptions.map((option) => option.tag)],
      ]);
    }
    default:
      return schema as HashableRecord;
  }
}

function projectSchemaRecord(record: Record<string, AnySchema>): Record<string, HashableRecord> {
  return Object.fromEntries(
    Object.entries(record).map(([key, schema]) => [key, projectSchema(schema)]),
  );
}

function projectMemberDescriptor(
  descriptor: MethodDescriptor | StreamDescriptor | StateDescriptor,
): HashableRecord {
  switch (descriptor.kind) {
    case 'fire':
      return withDefined([
        ['kind', descriptor.kind],
        ['params', descriptor.params !== undefined ? projectSchema(descriptor.params) : undefined],
      ]);
    case 'query':
    case 'querySync':
      return withDefined([
        ['kind', descriptor.kind],
        ['params', descriptor.params !== undefined ? projectSchema(descriptor.params) : undefined],
        ['result', projectSchema(descriptor.result)],
      ]);
    case 'stream':
      return withDefined([
        ['kind', descriptor.kind],
        ['params', descriptor.params !== undefined ? projectSchema(descriptor.params) : undefined],
        ['value', projectSchema(descriptor.value)],
      ]);
    case 'state':
      return withDefined([
        ['kind', descriptor.kind],
        ['value', projectSchema(descriptor.value)],
      ]);
    default:
      return descriptor;
  }
}

function projectMemberRecord<T extends MethodDescriptor | StreamDescriptor | StateDescriptor>(
  record: Record<string, T>,
): Record<string, HashableRecord> {
  return Object.fromEntries(
    Object.entries(record).map(([key, descriptor]) => [key, projectMemberDescriptor(descriptor)]),
  );
}

function projectContractDescriptor(descriptor: ContractDescriptor): HashableRecord {
  return {
    $type: descriptor.$type,
    id: descriptor.id,
    methods: projectMemberRecord(descriptor.methods),
    state: projectMemberRecord(descriptor.state),
    streams: projectMemberRecord(descriptor.streams),
  };
}

function wireIdentityProjection(value: unknown): unknown {
  if (isContractDescriptor(value)) return projectContractDescriptor(value);
  if (isMemberDescriptor(value)) return projectMemberDescriptor(value);
  return value;
}

// ---- FNV-1a 32-bit --------------------------------------------------------

function utf8Bytes(str: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);

  const bytes: number[] = [];
  for (const char of str) {
    const rawCodePoint = char.codePointAt(0);
    const codePoint =
      rawCodePoint !== undefined && rawCodePoint >= 0xd800 && rawCodePoint <= 0xdfff
        ? 0xfffd
        : rawCodePoint;
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export function hash8hex(str: string): string {
  let hash = 0x811c9dc5;
  for (const byte of utf8Bytes(str)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Compute a stable FNV-1a 32-bit hex hash over any serializable value.
 * Object keys are sorted recursively, so key insertion order does not affect the hash.
 */
export function stableHash(value: unknown): string {
  return hash8hex(sortedStringify(wireIdentityProjection(value)));
}

export function stableSchemaHash(schema: AnySchema): string {
  return hash8hex(sortedStringify(projectSchema(schema)));
}

export function oneOfOptionTag(schema: AnySchema): string {
  return `${schema.kind}:${stableSchemaHash(schema)}`;
}

export function deriveOneOfOptionTags(options: readonly AnySchema[]): readonly string[] {
  const tags = options.map(oneOfOptionTag);
  const seen = new Set<string>();
  for (const tag of tags) {
    if (seen.has(tag)) {
      throw new Error(
        `[bridgekit] oneOf duplicate structural tag "${tag}". ` +
          'oneOf options must have unique wire identity.',
      );
    }
    seen.add(tag);
  }
  return tags;
}

/**
 * Compute per-member hashes for skew diffing.
 * Keys use the path prefix: "methods.x", "streams.y", "state.z".
 */
export function memberHashes(descriptor: ContractDescriptor): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, desc] of Object.entries(descriptor.methods)) {
    result[`methods.${name}`] = stableHash(desc);
  }
  for (const [name, desc] of Object.entries(descriptor.streams)) {
    result[`streams.${name}`] = stableHash(desc);
  }
  for (const [name, desc] of Object.entries(descriptor.state)) {
    result[`state.${name}`] = stableHash(desc);
  }

  return result;
}
