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
  EnumSchema,
  LiteralsSchema,
  NullableSchema,
  ObjectSchema,
  OneOfSchema,
  OptionalSchema,
  RecordSchema,
  TupleSchema,
  UnionSchema,
} from './schema';

// ---- internal helpers -----------------------------------------------------

// D6: Pure-JS base64 helpers — no Buffer dependency (safe for Hermes/JSC/RN).
// Standard base64 alphabet per RFC 4648.
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Lookup table: charCode → 6-bit value (or -1 for '=', -2 for invalid)
const BASE64_DECODE_TABLE = ((): Int8Array => {
  const t = new Int8Array(256).fill(-2);
  for (let i = 0; i < BASE64_CHARS.length; i++) {
    t[BASE64_CHARS.charCodeAt(i)] = i;
  }
  t['='.charCodeAt(0)] = -1; // padding
  return t;
})();

/** Encode a Uint8Array to a base64 string (no line breaks, standard alphabet). */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Use charAt() so noUncheckedIndexedAccess doesn't widen the return to string|undefined.
  const c = (idx: number): string => BASE64_CHARS.charAt(idx);
  const len = bytes.length;
  let out = '';
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out +=
      c(b0 >> 2) +
      c(((b0 & 0x03) << 4) | (b1 >> 4)) +
      c(((b1 & 0x0f) << 2) | (b2 >> 6)) +
      c(b2 & 0x3f);
  }
  if (i + 1 === len) {
    const b0 = bytes[i] ?? 0;
    out += `${c(b0 >> 2) + c((b0 & 0x03) << 4)}==`;
  } else if (i + 2 === len) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    out += `${c(b0 >> 2) + c(((b0 & 0x03) << 4) | (b1 >> 4)) + c((b1 & 0x0f) << 2)}=`;
  }
  return out;
}

/** Decode a base64 string to a Uint8Array. Non-base64 chars are ignored (RFC 4648 §3.3 permissive). */
function base64ToUint8Array(str: string): Uint8Array {
  // Int8Array[n] returns number|undefined with noUncheckedIndexedAccess; ?? -2 keeps the -2 default.
  const lookup = (code: number): number => BASE64_DECODE_TABLE[code] ?? -2;
  // Pre-pass: count valid chars and padding to size the output buffer.
  let validChars = 0;
  let padCount = 0;
  for (let i = 0; i < str.length; i++) {
    const v = lookup(str.charCodeAt(i));
    if (v === -1) padCount++;
    else if (v >= 0) validChars++;
  }
  // Standard formula: every 4 base64 chars → 3 bytes; subtract padding.
  const byteLen = Math.floor(((validChars + padCount) * 3) / 4) - padCount;
  const out = new Uint8Array(byteLen);
  let outIdx = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    const v = lookup(str.charCodeAt(i));
    if (v < 0) {
      if (v === -1) break; // padding: stop
      continue; // -2: non-alphabet char, skip
    }
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIdx++] = (buf >> bits) & 0xff;
    }
  }
  return outIdx === byteLen ? out : out.slice(0, outIdx);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isReservedObjectKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function createNullProtoRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
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
    const result = createNullProtoRecord();
    for (const [k, v] of Object.entries(value)) {
      if (isReservedObjectKey(k)) continue;
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

function sanitizeDecodePassthrough(value: unknown): unknown {
  if (Array.isArray(value) || isObject(value)) return sanitizeAny(value);
  return value;
}

function isOptionalSchema(schema: AnySchema): schema is OptionalSchema {
  return schema.kind === 'optional';
}

function encodeCollectionItem(schema: AnySchema, value: unknown): unknown {
  const encoded = encode(schema, value);
  // Positional null represents both an optional gap and a nullable null, matching
  // native parity: Kotlin List<T?> / Swift [T?] cannot distinguish them in JSON arrays.
  if (encoded === undefined && isOptionalSchema(schema)) return null;
  return encoded;
}

function oneOfError(operation: 'encode' | 'decode', message: string): TypeError {
  return new TypeError(`[bridgekit] oneOf ${operation}: ${message}`);
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
        .map((item) => encodeCollectionItem(arraySchema.item, item))
        .filter((v) => v !== undefined);
    }

    case 'record': {
      if (!isObject(value)) return value;
      const recordSchema = schema as RecordSchema;
      const result = createNullProtoRecord();
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (isReservedObjectKey(k)) continue;
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

    case 'int64': {
      // bigint passes through as Int64 on the AnyMap wire
      return value;
    }

    case 'date': {
      if (!(value instanceof Date) || Number.isNaN((value as Date).getTime())) return value;
      return (value as Date).getTime();
    }

    case 'binary': {
      let bytes: Uint8Array;
      if (value instanceof Uint8Array) {
        bytes = value;
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else {
        return value;
      }
      // D6: inline pure-JS base64 — no Buffer dependency (Hermes/JSC/RN safe)
      return uint8ArrayToBase64(bytes);
    }

    case 'enum': {
      const enumSchema = schema as EnumSchema;
      const isValid = enumSchema.members.some((m) => m.value === value);
      if (!isValid) return value;
      return value; // wire is the numeric value
    }

    case 'tuple': {
      if (!Array.isArray(value)) return value;
      const tupleSchema = schema as TupleSchema;
      return tupleSchema.items.map((itemSchema, i) =>
        encodeCollectionItem(itemSchema, (value as unknown[])[i]),
      );
    }

    case 'oneOf': {
      const oneOfSchema = schema as OneOfSchema;
      for (let i = 0; i < oneOfSchema.options.length; i++) {
        const opt = oneOfSchema.options[i];
        if (opt === undefined) continue;
        const result = validateAt(opt, value, '');
        if (result.ok) {
          return { '@k': i, '@v': encode(opt, value) };
        }
      }
      throw oneOfError('encode', `value did not match any option (got ${typeof value})`);
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
      return sanitizeDecodePassthrough(value);

    case 'json':
      return sanitizeJson(value);

    case 'literals':
      return sanitizeDecodePassthrough(value); // skew tolerance: unknown values pass through

    case 'optional': {
      // Positional null represents both optional gaps and nullable nulls in collections;
      // optional(nullable(T)) therefore decodes both wire null cases to undefined.
      if (value === undefined || value === null) return undefined;
      return decode((schema as OptionalSchema).inner, value);
    }

    case 'nullable': {
      if (value === null) return null;
      if (value === undefined) return null;
      return decode((schema as NullableSchema).inner, value);
    }

    case 'object': {
      if (!isObject(value)) return sanitizeDecodePassthrough(value);
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
      if (!Array.isArray(value)) return sanitizeDecodePassthrough(value);
      const arraySchema = schema as ArraySchema;
      return (value as unknown[]).map((item) => decode(arraySchema.item, item));
    }

    case 'record': {
      if (!isObject(value)) return sanitizeDecodePassthrough(value);
      const recordSchema = schema as RecordSchema;
      const result = createNullProtoRecord();
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (isReservedObjectKey(k)) continue;
        result[k] = decode(recordSchema.value, v);
      }
      return result;
    }

    case 'union': {
      if (!isObject(value)) return sanitizeDecodePassthrough(value);
      const unionSchema = schema as UnionSchema;
      const discriminantValue = (value as Record<string, unknown>)[unionSchema.discriminant];
      if (typeof discriminantValue !== 'string') return sanitizeDecodePassthrough(value);
      const variantSchema = unionSchema.variants[discriminantValue];
      if (!variantSchema) return sanitizeDecodePassthrough(value);
      const decoded = decode(variantSchema, value) as Record<string, unknown>;
      if (isObject(decoded)) {
        return { [unionSchema.discriminant]: discriminantValue, ...decoded };
      }
      return decoded;
    }

    case 'int64': {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number') return BigInt(Math.trunc(value));
      return BigInt(String(value));
    }

    case 'date': {
      if (value instanceof Date) return new Date(value.getTime());
      // C-1: Kotlin Long arrives as bigint via Nitro Int64; new Date(bigint) throws TypeError.
      // Handle both bigint (native bridge path) and number (JS self-invoke / older wire).
      const ms = typeof value === 'bigint' ? Number(value) : (value as number);
      return new Date(ms);
    }

    case 'binary': {
      if (value instanceof Uint8Array) return new Uint8Array(value);
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      // D6: wire is base64 string — decode without Buffer (Hermes/JSC/RN safe)
      return base64ToUint8Array(value as string);
    }

    case 'enum': {
      // wire is the numeric value — return as-is (skew tolerance)
      return sanitizeDecodePassthrough(value);
    }

    case 'tuple': {
      if (!Array.isArray(value)) return sanitizeDecodePassthrough(value);
      const tupleSchema = schema as TupleSchema;
      return tupleSchema.items.map((itemSchema, i) => decode(itemSchema, (value as unknown[])[i]));
    }

    case 'oneOf': {
      if (!isObject(value)) {
        throw oneOfError(
          'decode',
          `expected @k/@v envelope, got ${Array.isArray(value) ? 'array' : typeof value}`,
        );
      }
      const oneOfSchema = schema as OneOfSchema;
      const envelope = value as Record<string, unknown>;
      const rawK = envelope['@k'];
      // 5.1-5.2: @k must be a number — throw descriptively if absent or wrong type
      if (typeof rawK !== 'number') {
        throw new TypeError(
          `[bridgekit] oneOf decode: @k must be a number, got ${typeof rawK} (value: ${String(rawK)})`,
        );
      }
      // 5.1: @v must be present (the key must exist)
      if (!('@v' in envelope)) {
        throw new TypeError(
          `[bridgekit] oneOf decode: @v is missing from envelope (schema has ${oneOfSchema.options.length} option(s))`,
        );
      }
      // 5.3: @k must be within range
      const opt = oneOfSchema.options[rawK];
      if (opt === undefined) {
        throw new RangeError(
          `[bridgekit] oneOf decode: @k=${rawK} is out of range (schema has ${oneOfSchema.options.length} option(s))`,
        );
      }
      const decoded = decode(opt, envelope['@v']);
      const result = validateAt(opt, decoded, '');
      if (!result.ok) {
        throw oneOfError('decode', `@v did not match option @k=${rawK}: ${result.message}`);
      }
      return decoded;
    }

    default:
      return sanitizeDecodePassthrough(value);
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

    case 'int64': {
      if (typeof value !== 'bigint') {
        return validationError(path, `Expected bigint (int64), got ${typeof value}`);
      }
      return { ok: true };
    }

    case 'date': {
      if (!(value instanceof Date) || Number.isNaN((value as Date).getTime())) {
        return validationError(path, `Expected valid Date, got ${typeof value}`);
      }
      return { ok: true };
    }

    case 'binary': {
      if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
        return validationError(path, `Expected Uint8Array or ArrayBuffer, got ${typeof value}`);
      }
      return { ok: true };
    }

    case 'enum': {
      const enumSchema = schema as EnumSchema;
      if (!enumSchema.members.some((m) => m.value === value)) {
        const validValues = enumSchema.members.map((m) => m.value).join(', ');
        return validationError(
          path,
          `Expected one of enum values [${validValues}], got ${JSON.stringify(value)}`,
        );
      }
      return { ok: true };
    }

    case 'tuple': {
      if (!Array.isArray(value)) {
        return validationError(path, `Expected tuple (array), got ${typeof value}`);
      }
      const tupleSchema = schema as TupleSchema;
      if ((value as unknown[]).length !== tupleSchema.items.length) {
        return validationError(
          path,
          `Expected tuple of arity ${tupleSchema.items.length}, got ${(value as unknown[]).length}`,
        );
      }
      for (let i = 0; i < tupleSchema.items.length; i++) {
        const item = tupleSchema.items[i];
        if (item === undefined) break;
        const result = validateAt(item, (value as unknown[])[i], `${path}[${i}]`);
        if (!result.ok) return result;
      }
      return { ok: true };
    }

    case 'oneOf': {
      const oneOfSchema = schema as OneOfSchema;
      const hasMatch = oneOfSchema.options.some((opt) => validateAt(opt, value, path).ok);
      if (!hasMatch) {
        return validationError(
          path,
          `Value did not match any oneOf option: ${JSON.stringify(value)}`,
        );
      }
      return { ok: true };
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
