import { type AnySchema, encode } from '@malopezr7/bridgekit/contract';

import { CliError } from '../cliError.js';
import type {
  ArrayNode,
  NullableNode,
  ObjectNode,
  OneOfNode,
  OptionalNode,
  RecordNode,
  SchemaNode,
  TupleNode,
  UnionNode,
} from './types.js';

function unsupportedKind(schema: SchemaNode, path: string): never {
  throw new CliError(`Unsupported schema kind '${schema.kind}' at ${path}`);
}

/** Validate the CLI's open descriptor shape before crossing into the closed core codec union. */
function supportedSchema(schema: SchemaNode, path: string): AnySchema {
  switch (schema.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'void':
    case 'json':
    case 'literals':
    case 'int64':
    case 'date':
    case 'binary':
    case 'enum':
      return schema as AnySchema;
    case 'object':
      for (const [key, field] of Object.entries((schema as ObjectNode).fields)) {
        supportedSchema(field, `${path}.fields.${key}`);
      }
      return schema as AnySchema;
    case 'array':
      supportedSchema((schema as ArrayNode).item, `${path}.item`);
      return schema as AnySchema;
    case 'record':
      supportedSchema((schema as RecordNode).value, `${path}.value`);
      return schema as AnySchema;
    case 'optional':
    case 'nullable':
      supportedSchema((schema as OptionalNode | NullableNode).inner, `${path}.inner`);
      return schema as AnySchema;
    case 'union':
      for (const [key, variant] of Object.entries((schema as UnionNode).variants)) {
        supportedSchema(variant, `${path}.variants.${key}`);
      }
      return schema as AnySchema;
    case 'tuple':
      (schema as TupleNode).items.forEach((item, index) => {
        supportedSchema(item, `${path}.items[${index}]`);
      });
      return schema as AnySchema;
    case 'oneOf':
      (schema as OneOfNode).options.forEach((option, index) => {
        supportedSchema(option, `${path}.options[${index}]`);
      });
      return schema as AnySchema;
    default:
      return unsupportedKind(schema, path);
  }
}

function richJsonKind(value: unknown): string | undefined {
  if (value instanceof Date) return 'Date';
  if (value instanceof Uint8Array) return 'Uint8Array';
  if (value instanceof ArrayBuffer) return 'ArrayBuffer';
  if (typeof value === 'bigint') return 'BigInt';
  return undefined;
}

function assertNoRichJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  const kind = richJsonKind(value);
  if (kind) {
    throw new CliError(`State initial at ${path} is not JSON-compatible: ${kind}`);
  }
  if (value === null || typeof value !== 'object') return;
  if (ancestors.has(value)) return;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        assertNoRichJsonValue(item, `${path}[${index}]`, ancestors);
      });
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      assertNoRichJsonValue(item, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertJsonNodes(schema: SchemaNode, raw: unknown, encoded: unknown, path: string): void {
  switch (schema.kind) {
    case 'json':
      assertNoRichJsonValue(raw, path, new Set());
      return;
    case 'optional':
    case 'nullable':
      if (raw !== null && raw !== undefined) {
        assertJsonNodes((schema as OptionalNode | NullableNode).inner, raw, encoded, path);
      }
      return;
    case 'object': {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
      const rawObject = raw as Record<string, unknown>;
      const encodedObject = encoded as Record<string, unknown> | null;
      for (const [key, field] of Object.entries((schema as ObjectNode).fields)) {
        assertJsonNodes(field, rawObject[key], encodedObject?.[key], `${path}.${key}`);
      }
      return;
    }
    case 'record': {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
      const encodedObject = encoded as Record<string, unknown> | null;
      for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
        assertJsonNodes((schema as RecordNode).value, item, encodedObject?.[key], `${path}.${key}`);
      }
      return;
    }
    case 'array':
      if (Array.isArray(raw)) {
        raw.forEach((item, index) => {
          assertJsonNodes(
            (schema as ArrayNode).item,
            item,
            Array.isArray(encoded) ? encoded[index] : undefined,
            `${path}[${index}]`,
          );
        });
      }
      return;
    case 'tuple':
      if (Array.isArray(raw)) {
        (schema as TupleNode).items.forEach((item, index) => {
          assertJsonNodes(
            item,
            raw[index],
            Array.isArray(encoded) ? encoded[index] : undefined,
            `${path}[${index}]`,
          );
        });
      }
      return;
    case 'union': {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
      const union = schema as UnionNode;
      const variant = union.variants[String((raw as Record<string, unknown>)[union.discriminant])];
      if (variant) assertJsonNodes(variant, raw, encoded, path);
      return;
    }
    case 'oneOf': {
      if (encoded === null || typeof encoded !== 'object' || Array.isArray(encoded)) return;
      const oneOf = schema as OneOfNode;
      const envelope = encoded as Record<string, unknown>;
      const optionIndex = oneOf.tags?.indexOf(String(envelope['@t'])) ?? -1;
      const option = oneOf.options[optionIndex];
      if (option) assertJsonNodes(option, raw, envelope['@v'], path);
      return;
    }
  }
}

export function prepareStateInitial(
  value: unknown,
  schema: SchemaNode,
  path = 'state initial',
): { encoded: unknown } {
  const coreSchema = supportedSchema(schema, `${path}.schema`);
  const encoded = encode(coreSchema, value);
  assertJsonNodes(schema, value, encoded, path);
  return { encoded };
}
