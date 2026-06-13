// ---------------------------------------------------------------------------
// Codec — encode / decode / validate
//
// encode: walks declared schema, copies only declared fields, strips undefined
//         and functions, sanitizes t.json() deeply.
// decode: symmetric walk, tolerant of extra keys (drops them).
// validate: full type check returning { ok, path, message }.
//
// No imports from react or react-native (purity contract).
// ---------------------------------------------------------------------------

import type {
  AnySchema,
  ArraySchema,
  LiteralsSchema,
  NullableSchema,
  ObjectSchema,
  OptionalSchema,
  RecordSchema,
  UnionSchema,
} from './schema';

// ---- internal helpers -----------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-sanitize an arbitrary value for t.json():
 * - strips undefined fields from objects
 * - strips function values from objects
 * - recurses into nested objects/arrays
 *
 * Also used as the universal schema-less sanitizer for marker contracts
 * (no schema → deep sanitize all outbound payloads to prevent AnyMap crashes).
 * Exported as sanitizeAny for use by the runtime.
 */
export function sanitizeAny(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'function') return undefined;
  if (Array.isArray(value)) {
    return value.map(sanitizeAny).filter((v) => v !== undefined);
  }
  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || typeof v === 'function') continue;
      const sanitized = sanitizeAny(v);
      if (sanitized !== undefined) {
        result[k] = sanitized;
      }
    }
    return result;
  }
  return value;
}

// sanitizeJson reuses sanitizeAny (same algorithm)
function sanitizeJson(value: unknown): unknown {
  return sanitizeAny(value);
}

// ---- encode ---------------------------------------------------------------

/**
 * Encode a value according to its schema for transport.
 *
 * - Walks the DECLARED schema only (no unknown keys pass through).
 * - Skips undefined and function values in objects/records.
 * - t.json() values get a deep sanitize (strips undefined/functions).
 * - Output is safe for JSON-shaped transport (no undefined inside objects/arrays).
 */
export function encode(schema: AnySchema, value: unknown): unknown {
  switch (schema.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;

    case 'void':
      return undefined;

    case 'json':
      return sanitizeJson(value);

    case 'literals':
      return value;

    case 'optional': {
      if (value === undefined) return undefined;
      return encode((schema as OptionalSchema).inner, value);
    }

    case 'nullable': {
      if (value === null) return null;
      return encode((schema as NullableSchema).inner, value);
    }

    case 'object': {
      if (!isObject(value)) return value;
      const objectSchema = schema as ObjectSchema;
      const result: Record<string, unknown> = {};
      for (const [key, fieldSchema] of Object.entries(objectSchema.fields)) {
        const fieldValue = (value as Record<string, unknown>)[key];
        if (fieldValue === undefined) continue; // skip missing/undefined fields
        if (typeof fieldValue === 'function') continue; // skip functions
        const encoded = encode(fieldSchema, fieldValue);
        if (encoded !== undefined) {
          result[key] = encoded;
        }
      }
      return result;
    }

    case 'array': {
      if (!Array.isArray(value)) return value;
      const arraySchema = schema as ArraySchema;
      return (value as unknown[])
        .map((item) => encode(arraySchema.item, item))
        .filter((v) => v !== undefined);
    }

    case 'record': {
      if (!isObject(value)) return value;
      const recordSchema = schema as RecordSchema;
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined || typeof v === 'function') continue;
        const encoded = encode(recordSchema.value, v);
        if (encoded !== undefined) {
          result[k] = encoded;
        }
      }
      return result;
    }

    case 'union': {
      if (!isObject(value)) return value;
      const unionSchema = schema as UnionSchema;
      const discriminantValue = (value as Record<string, unknown>)[unionSchema.discriminant];
      if (typeof discriminantValue !== 'string') return value;
      const variantSchema = unionSchema.variants[discriminantValue];
      if (!variantSchema) return value;
      const encoded = encode(variantSchema, value) as Record<string, unknown>;
      if (isObject(encoded)) {
        return { [unionSchema.discriminant]: discriminantValue, ...encoded };
      }
      return encoded;
    }

    default:
      return value;
  }
}

// ---- decode ---------------------------------------------------------------

/**
 * Decode a transport value to its typed form.
 *
 * - Tolerant of extra keys (drops them).
 * - optional/missing → undefined
 * - nullable/null → null
 * - literals decoded as-is (skew tolerance handled at higher layers).
 */
export function decode(schema: AnySchema, value: unknown): unknown {
  switch (schema.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'void':
      return value;

    case 'json':
      return value;

    case 'literals':
      return value; // skew tolerance: unknown values pass through

    case 'optional': {
      if (value === undefined || value === null) return undefined;
      return decode((schema as OptionalSchema).inner, value);
    }

    case 'nullable': {
      if (value === null) return null;
      if (value === undefined) return null;
      return decode((schema as NullableSchema).inner, value);
    }

    case 'object': {
      if (!isObject(value)) return value;
      const objectSchema = schema as ObjectSchema;
      const result: Record<string, unknown> = {};
      for (const [key, fieldSchema] of Object.entries(objectSchema.fields)) {
        const fieldValue = (value as Record<string, unknown>)[key];
        const decoded = decode(fieldSchema, fieldValue);
        if (decoded !== undefined) {
          result[key] = decoded;
        }
      }
      return result;
    }

    case 'array': {
      if (!Array.isArray(value)) return value;
      const arraySchema = schema as ArraySchema;
      return (value as unknown[]).map((item) => decode(arraySchema.item, item));
    }

    case 'record': {
      if (!isObject(value)) return value;
      const recordSchema = schema as RecordSchema;
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = decode(recordSchema.value, v);
      }
      return result;
    }

    case 'union': {
      if (!isObject(value)) return value;
      const unionSchema = schema as UnionSchema;
      const discriminantValue = (value as Record<string, unknown>)[unionSchema.discriminant];
      if (typeof discriminantValue !== 'string') return value;
      const variantSchema = unionSchema.variants[discriminantValue];
      if (!variantSchema) return value;
      const decoded = decode(variantSchema, value) as Record<string, unknown>;
      if (isObject(decoded)) {
        return { [unionSchema.discriminant]: discriminantValue, ...decoded };
      }
      return decoded;
    }

    default:
      return value;
  }
}

// ---- validate -------------------------------------------------------------

export type ValidationResult = { ok: true } | { ok: false; path: string; message: string };

function validationError(path: string, message: string): ValidationResult {
  return { ok: false, path, message };
}

function appendPath(base: string, segment: string): string {
  if (!base) return segment;
  return `${base}.${segment}`;
}

function validateAt(schema: AnySchema, value: unknown, path: string): ValidationResult {
  switch (schema.kind) {
    case 'string':
      if (typeof value !== 'string') {
        return validationError(path, `Expected string, got ${typeof value}`);
      }
      return { ok: true };

    case 'number':
      if (typeof value !== 'number') {
        return validationError(path, `Expected number, got ${typeof value}`);
      }
      return { ok: true };

    case 'boolean':
      if (typeof value !== 'boolean') {
        return validationError(path, `Expected boolean, got ${typeof value}`);
      }
      return { ok: true };

    case 'void':
      if (value !== undefined) {
        return validationError(path, `Expected undefined (void), got ${typeof value}`);
      }
      return { ok: true };

    case 'json':
      // t.json() is always valid (intentional escape hatch)
      return { ok: true };

    case 'literals': {
      const literalsSchema = schema as LiteralsSchema;
      if (!(literalsSchema.values as readonly unknown[]).includes(value)) {
        return validationError(
          path,
          `Expected one of literal values [${literalsSchema.values.map(String).join(', ')}], got ${JSON.stringify(value)}`,
        );
      }
      return { ok: true };
    }

    case 'optional': {
      if (value === undefined) return { ok: true };
      return validateAt((schema as OptionalSchema).inner, value, path);
    }

    case 'nullable': {
      if (value === null) return { ok: true };
      return validateAt((schema as NullableSchema).inner, value, path);
    }

    case 'object': {
      if (!isObject(value)) {
        return validationError(path, `Expected object, got ${typeof value}`);
      }
      const objectSchema = schema as ObjectSchema;
      for (const [key, fieldSchema] of Object.entries(objectSchema.fields)) {
        const fieldValue = (value as Record<string, unknown>)[key];
        const result = validateAt(fieldSchema, fieldValue, appendPath(path, key));
        if (!result.ok) return result;
      }
      return { ok: true };
    }

    case 'array': {
      if (!Array.isArray(value)) {
        return validationError(path, `Expected array, got ${typeof value}`);
      }
      const arraySchema = schema as ArraySchema;
      for (let i = 0; i < value.length; i++) {
        const result = validateAt(arraySchema.item, value[i], `${path}[${i}]`);
        if (!result.ok) return result;
      }
      return { ok: true };
    }

    case 'record': {
      if (!isObject(value)) {
        return validationError(path, `Expected record (object), got ${typeof value}`);
      }
      const recordSchema = schema as RecordSchema;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const result = validateAt(recordSchema.value, v, appendPath(path, k));
        if (!result.ok) return result;
      }
      return { ok: true };
    }

    case 'union': {
      if (!isObject(value)) {
        return validationError(path, `Expected discriminated union object, got ${typeof value}`);
      }
      const unionSchema = schema as UnionSchema;
      const discriminantValue = (value as Record<string, unknown>)[unionSchema.discriminant];
      if (typeof discriminantValue !== 'string') {
        return validationError(
          appendPath(path, unionSchema.discriminant),
          `Expected string discriminant "${unionSchema.discriminant}"`,
        );
      }
      const variantSchema = unionSchema.variants[discriminantValue];
      if (!variantSchema) {
        return validationError(
          appendPath(path, unionSchema.discriminant),
          `Unknown variant "${discriminantValue}"`,
        );
      }
      return validateAt(variantSchema, value, path);
    }

    default:
      return { ok: true };
  }
}

/**
 * Validate a value against a schema.
 * Returns `{ ok: true }` or `{ ok: false, path, message }`.
 * This is the dev-only layer (validation adds overhead).
 */
export function validate(schema: AnySchema, value: unknown): ValidationResult {
  return validateAt(schema, value, '');
}
