import { decode, encode, validate } from '../codec';
import { t } from '../schema';

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------
describe('encode – strips unknown keys and unsafe values', () => {
  it('encodes a simple object, keeping declared fields', () => {
    const schema = t.object({ name: t.string(), age: t.number() });
    const result = encode(schema, { name: 'Alice', age: 30 });
    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('strips unknown keys from object', () => {
    const schema = t.object({ name: t.string() });
    const result = encode(schema, { name: 'Alice', extra: 'ignored' } as unknown as {
      name: string;
    });
    expect(result).toEqual({ name: 'Alice' });
    expect('extra' in (result as Record<string, unknown>)).toBe(false);
  });

  it('strips undefined fields from output (JSON-safe)', () => {
    const schema = t.object({ name: t.string(), tag: t.optional(t.string()) });
    const result = encode(schema, { name: 'Alice', tag: undefined });
    // undefined fields must not appear in output object
    expect(Object.keys(result as Record<string, unknown>)).not.toContain('tag');
  });

  it('strips function values from object fields', () => {
    const schema = t.object({ name: t.string(), fn: t.json() });
    const result = encode(schema, { name: 'Alice', fn: () => 'noop' } as unknown as {
      name: string;
      fn: unknown;
    });
    const obj = result as Record<string, unknown>;
    expect(obj['name']).toBe('Alice');
    // fn is a function → should be stripped or sanitized away
    expect(obj['fn']).toBeUndefined();
  });

  it('output JSON-round-trips cleanly (no undefined in objects)', () => {
    const schema = t.object({ a: t.string(), b: t.optional(t.number()) });
    const result = encode(schema, { a: 'hello', b: undefined });
    const serialized = JSON.stringify(result);
    expect(() => JSON.parse(serialized)).not.toThrow();
    // Re-parse must not have undefined
    const reparsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(reparsed['b']).toBeUndefined(); // key absent, not undefined value
  });

  it('handles nested objects', () => {
    const schema = t.object({
      user: t.object({ id: t.string(), name: t.string() }),
    });
    const result = encode(schema, {
      user: { id: '1', name: 'Alice', extra: 'ignored' } as unknown as { id: string; name: string },
    });
    const obj = result as { user: Record<string, unknown> };
    expect(obj.user).toEqual({ id: '1', name: 'Alice' });
    expect('extra' in obj.user).toBe(false);
  });

  it('handles arrays', () => {
    const schema = t.array(t.number());
    const result = encode(schema, [1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
  });

  it('handles records', () => {
    const schema = t.record(t.string());
    const result = encode(schema, { a: 'x', b: 'y' });
    expect(result).toEqual({ a: 'x', b: 'y' });
  });

  it('handles union – routes by discriminant', () => {
    const schema = t.union('type', {
      text: t.object({ content: t.string() }),
      num: t.object({ value: t.number() }),
    });
    const result = encode(schema, { type: 'text', content: 'hello' } as t.Infer<typeof schema>);
    expect(result).toEqual({ type: 'text', content: 'hello' });
  });

  it('sanitizes t.json() deeply – strips undefined and functions', () => {
    const schema = t.json();
    const result = encode(schema, {
      a: 1,
      b: undefined,
      c: () => 'noop',
      d: { nested: undefined, value: 'ok' },
    } as unknown);
    const obj = result as Record<string, unknown>;
    expect('b' in obj).toBe(false);
    expect('c' in obj).toBe(false);
    const d = obj['d'] as Record<string, unknown>;
    expect('nested' in d).toBe(false);
    expect(d['value']).toBe('ok');
  });

  it('handles void (encodes undefined as undefined)', () => {
    const schema = t.void();
    const result = encode(schema, undefined);
    expect(result).toBeUndefined();
  });

  it('handles nullable – passes null through', () => {
    const schema = t.nullable(t.string());
    expect(encode(schema, null)).toBeNull();
    expect(encode(schema, 'hello')).toBe('hello');
  });

  it('handles optional – passes undefined through', () => {
    const schema = t.optional(t.string());
    expect(encode(schema, undefined)).toBeUndefined();
    expect(encode(schema, 'hi')).toBe('hi');
  });
});

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------
describe('decode – tolerant, drops extra keys', () => {
  it('decodes simple object, dropping extra keys', () => {
    const schema = t.object({ name: t.string() });
    const result = decode(schema, { name: 'Bob', extra: 'dropped' });
    expect(result).toEqual({ name: 'Bob' });
    expect('extra' in (result as Record<string, unknown>)).toBe(false);
  });

  it('optional field absent → undefined', () => {
    const schema = t.object({ name: t.string(), tag: t.optional(t.string()) });
    const result = decode(schema, { name: 'Bob' }) as { name: string; tag?: string };
    expect(result.tag).toBeUndefined();
  });

  it('nullable field null → null', () => {
    const schema = t.nullable(t.string());
    expect(decode(schema, null)).toBeNull();
  });

  it('decodes union by discriminant', () => {
    const schema = t.union('type', {
      a: t.object({ value: t.string() }),
      b: t.object({ count: t.number() }),
    });
    const result = decode(schema, { type: 'a', value: 'hello', extra: 'x' });
    expect(result).toEqual({ type: 'a', value: 'hello' });
  });

  it('decodes array of objects', () => {
    const schema = t.array(t.object({ id: t.string() }));
    const result = decode(schema, [{ id: '1', extra: 'x' }, { id: '2' }]) as Array<{ id: string }>;
    expect(result[0]).toEqual({ id: '1' });
    expect(result[1]).toEqual({ id: '2' });
  });

  it('decodes record values', () => {
    const schema = t.record(t.number());
    const result = decode(schema, { a: 1, b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('literals decoded as-is (skew tolerance)', () => {
    const schema = t.literals('a', 'b');
    // Unknown value decoded as-is per spec
    expect(decode(schema, 'c')).toBe('c');
    expect(decode(schema, 'a')).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------
describe('validate – full type checking', () => {
  it('returns ok:true for valid string', () => {
    const result = validate(t.string(), 'hello');
    expect(result.ok).toBe(true);
  });

  it('returns ok:false for wrong type', () => {
    const result = validate(t.string(), 42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBeDefined();
      expect(result.message).toBeDefined();
    }
  });

  it('validates number', () => {
    expect(validate(t.number(), 42).ok).toBe(true);
    expect(validate(t.number(), 'x').ok).toBe(false);
  });

  it('validates boolean', () => {
    expect(validate(t.boolean(), true).ok).toBe(true);
    expect(validate(t.boolean(), 0).ok).toBe(false);
  });

  it('validates literals – valid', () => {
    const schema = t.literals('a', 'b', 'c');
    expect(validate(schema, 'a').ok).toBe(true);
    expect(validate(schema, 'b').ok).toBe(true);
  });

  it('validates literals – invalid', () => {
    const schema = t.literals('a', 'b');
    const result = validate(schema, 'd');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/literal/i);
    }
  });

  it('validates object fields with correct path', () => {
    const schema = t.object({ name: t.string(), age: t.number() });
    const result = validate(schema, { name: 42, age: 30 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toContain('name');
    }
  });

  it('validates nested objects with path drill-down', () => {
    const schema = t.object({
      user: t.object({ id: t.string() }),
    });
    const result = validate(schema, { user: { id: 42 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toContain('user');
      expect(result.path).toContain('id');
    }
  });

  it('validates array items', () => {
    const schema = t.array(t.number());
    expect(validate(schema, [1, 2, 3]).ok).toBe(true);
    const result = validate(schema, [1, 'x', 3]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toContain('[1]');
    }
  });

  it('validates union by discriminant', () => {
    const schema = t.union('kind', {
      a: t.object({ value: t.string() }),
      b: t.object({ count: t.number() }),
    });
    expect(validate(schema, { kind: 'a', value: 'hello' }).ok).toBe(true);
    expect(validate(schema, { kind: 'b', count: 42 }).ok).toBe(true);
    expect(validate(schema, { kind: 'a', value: 123 }).ok).toBe(false);
  });

  it('validates optional – undefined is ok, wrong type is not', () => {
    const schema = t.optional(t.string());
    expect(validate(schema, undefined).ok).toBe(true);
    expect(validate(schema, 'hello').ok).toBe(true);
    expect(validate(schema, 42).ok).toBe(false);
  });

  it('validates nullable – null is ok, wrong type is not', () => {
    const schema = t.nullable(t.string());
    expect(validate(schema, null).ok).toBe(true);
    expect(validate(schema, 'hello').ok).toBe(true);
    expect(validate(schema, 42).ok).toBe(false);
  });

  it('validates void – undefined only', () => {
    expect(validate(t.void(), undefined).ok).toBe(true);
    expect(validate(t.void(), null).ok).toBe(false);
  });

  it('json schema always validates ok (escape hatch)', () => {
    expect(validate(t.json(), { any: 'thing' }).ok).toBe(true);
    expect(validate(t.json(), null).ok).toBe(true);
    expect(validate(t.json(), 42).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W2 Nitro-parity types — round-trip tests
// ---------------------------------------------------------------------------

describe('W2 T05 — t.int64() round-trip (bigint, precision above 2^53)', () => {
  const schema = t.int64();
  const VALUE_ABOVE_MAX_SAFE = 9007199254740993n; // 2^53 + 1

  it('encode passes bigint through (wire = bigint)', () => {
    expect(encode(schema, VALUE_ABOVE_MAX_SAFE)).toBe(VALUE_ABOVE_MAX_SAFE);
  });

  it('decode bigint → bigint', () => {
    expect(decode(schema, VALUE_ABOVE_MAX_SAFE)).toBe(VALUE_ABOVE_MAX_SAFE);
  });

  it('decode number → bigint (from wire)', () => {
    // Small values may arrive as number from AnyMap
    expect(decode(schema, 42 as unknown as bigint)).toBe(42n);
  });

  it('full round-trip preserves value above 2^53', () => {
    const wire = encode(schema, VALUE_ABOVE_MAX_SAFE);
    const back = decode(schema, wire as bigint);
    expect(back).toBe(VALUE_ABOVE_MAX_SAFE);
  });

  it('validate ok for bigint', () => {
    expect(validate(schema, 9007199254740993n).ok).toBe(true);
  });

  it('validate fails for number', () => {
    expect(validate(schema, 42).ok).toBe(false);
  });

  it('int64 field inside object round-trips', () => {
    const objSchema = t.object({ count: t.int64(), label: t.string() });
    const encoded = encode(objSchema, { count: VALUE_ABOVE_MAX_SAFE, label: 'x' });
    const decoded = decode(objSchema, encoded);
    expect((decoded as { count: bigint }).count).toBe(VALUE_ABOVE_MAX_SAFE);
  });
});

describe('W2 T06 — t.date() round-trip (Date ↔ epoch millis)', () => {
  const schema = t.date();
  const KNOWN_DATE = new Date('2025-06-14T12:00:00.000Z');
  const KNOWN_MS = 1749902400000;

  it('encode Date → epoch millis (number)', () => {
    expect(encode(schema, KNOWN_DATE)).toBe(KNOWN_MS);
  });

  it('decode number → Date with same epoch millis', () => {
    const result = decode(schema, KNOWN_MS) as Date;
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(KNOWN_MS);
  });

  it('full round-trip preserves the instant', () => {
    const wire = encode(schema, KNOWN_DATE);
    const back = decode(schema, wire as number) as Date;
    expect(back.getTime()).toBe(KNOWN_DATE.getTime());
  });

  it('validate ok for valid Date', () => {
    expect(validate(schema, KNOWN_DATE).ok).toBe(true);
  });

  it('validate fails for invalid Date', () => {
    expect(validate(schema, new Date('invalid')).ok).toBe(false);
  });

  it('validate fails for number', () => {
    expect(validate(schema, KNOWN_MS).ok).toBe(false);
  });

  it('date field inside object round-trips', () => {
    const objSchema = t.object({ createdAt: t.date(), name: t.string() });
    const encoded = encode(objSchema, { createdAt: KNOWN_DATE, name: 'event' });
    expect((encoded as { createdAt: number }).createdAt).toBe(KNOWN_MS);
    const decoded = decode(objSchema, encoded) as { createdAt: Date; name: string };
    expect(decoded.createdAt.getTime()).toBe(KNOWN_MS);
  });
});

describe('W2 T07 — t.binary() round-trip (Uint8Array ↔ base64)', () => {
  const schema = t.binary();
  const BYTES = new Uint8Array([0x01, 0x02, 0xff]);

  it('encode Uint8Array → base64 string', () => {
    const wire = encode(schema, BYTES) as string;
    expect(typeof wire).toBe('string');
    // Decode back to verify correctness
    const back = Buffer.from(wire, 'base64');
    expect(back[0]).toBe(0x01);
    expect(back[1]).toBe(0x02);
    expect(back[2]).toBe(0xff);
  });

  it('encode ArrayBuffer → base64 string', () => {
    const wire = encode(schema, BYTES.buffer) as string;
    expect(typeof wire).toBe('string');
  });

  it('decode base64 string → Uint8Array preserving all bytes', () => {
    const wire = Buffer.from(BYTES).toString('base64');
    const result = decode(schema, wire) as Uint8Array;
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result[0]).toBe(0x01);
    expect(result[1]).toBe(0x02);
    expect(result[2]).toBe(0xff);
  });

  it('full round-trip preserves bytes', () => {
    const wire = encode(schema, BYTES);
    const back = decode(schema, wire as string) as Uint8Array;
    expect(back[0]).toBe(BYTES[0]);
    expect(back[1]).toBe(BYTES[1]);
    expect(back[2]).toBe(BYTES[2]);
  });

  it('validate ok for Uint8Array', () => {
    expect(validate(schema, BYTES).ok).toBe(true);
  });

  it('validate ok for ArrayBuffer', () => {
    expect(validate(schema, BYTES.buffer).ok).toBe(true);
  });

  it('validate fails for string', () => {
    expect(validate(schema, 'hello').ok).toBe(false);
  });
});

describe('W2 T08 — t.enum() round-trip (numeric members)', () => {
  const schema = t.enum({ Red: 0, Green: 1, Blue: 2 });

  it('encode passes numeric value through', () => {
    expect(encode(schema, 1)).toBe(1);
    expect(encode(schema, 0)).toBe(0);
  });

  it('decode passes numeric value through', () => {
    expect(decode(schema, 1)).toBe(1);
  });

  it('full round-trip: Green (1) → wire 1 → back 1', () => {
    const wire = encode(schema, 1);
    const back = decode(schema, wire as number);
    expect(back).toBe(1);
  });

  it('validate ok for known member value', () => {
    expect(validate(schema, 0).ok).toBe(true);
    expect(validate(schema, 1).ok).toBe(true);
    expect(validate(schema, 2).ok).toBe(true);
  });

  it('validate fails for unknown value', () => {
    expect(validate(schema, 99).ok).toBe(false);
  });

  it('validate fails for string', () => {
    expect(validate(schema, 'Green').ok).toBe(false);
  });
});

describe('W2 T09 — t.tuple() round-trip (positional array)', () => {
  const schema = t.tuple([t.string(), t.number()] as const);

  it('encode [string, number] → positional array', () => {
    const wire = encode(schema, ['hello', 42] as unknown as readonly [string, number]);
    expect(Array.isArray(wire)).toBe(true);
    expect((wire as unknown[])[0]).toBe('hello');
    expect((wire as unknown[])[1]).toBe(42);
  });

  it('decode positional array → tuple', () => {
    const result = decode(schema, ['hello', 42]) as [string, number];
    expect(result[0]).toBe('hello');
    expect(result[1]).toBe(42);
  });

  it('full round-trip preserves values and order', () => {
    const original: readonly [string, number] = ['hello', 42] as const;
    const wire = encode(schema, original as unknown as readonly [string, number]);
    const back = decode(schema, wire as [string, number]) as [string, number];
    expect(back[0]).toBe('hello');
    expect(back[1]).toBe(42);
  });

  it('validate ok for correct arity and types', () => {
    expect(validate(schema, ['hello', 42] as unknown as readonly [string, number]).ok).toBe(true);
  });

  it('validate fails for wrong arity', () => {
    expect(validate(schema, ['hello'] as unknown as readonly [string, number]).ok).toBe(false);
  });

  it('validate fails for wrong element type', () => {
    expect(validate(schema, ['hello', 'world'] as unknown as readonly [string, number]).ok).toBe(
      false,
    );
  });
});

describe('W2 T10 — t.oneOf() round-trip (primitive union, @k/@v envelope)', () => {
  const schema = t.oneOf([t.string(), t.number()] as const);

  it('string branch: encode → {"@k":0, "@v":"hello"}', () => {
    const wire = encode(schema, 'hello') as { '@k': number; '@v': unknown };
    expect(wire['@k']).toBe(0);
    expect(wire['@v']).toBe('hello');
  });

  it('number branch: encode → {"@k":1, "@v":99}', () => {
    const wire = encode(schema, 99) as { '@k': number; '@v': unknown };
    expect(wire['@k']).toBe(1);
    expect(wire['@v']).toBe(99);
  });

  it('string branch: decode {"@k":0, "@v":"hello"} → "hello"', () => {
    const result = decode(schema, { '@k': 0, '@v': 'hello' });
    expect(result).toBe('hello');
  });

  it('number branch: decode {"@k":1, "@v":99} → 99', () => {
    const result = decode(schema, { '@k': 1, '@v': 99 });
    expect(result).toBe(99);
  });

  it('full round-trip: string branch', () => {
    const wire = encode(schema, 'world');
    const back = decode(schema, wire as { '@k': number; '@v': unknown });
    expect(back).toBe('world');
  });

  it('full round-trip: number branch', () => {
    const wire = encode(schema, 3.14);
    const back = decode(schema, wire as { '@k': number; '@v': unknown });
    expect(back).toBe(3.14);
  });

  it('validate ok for string (matches opt 0)', () => {
    expect(validate(schema, 'hello').ok).toBe(true);
  });

  it('validate ok for number (matches opt 1)', () => {
    expect(validate(schema, 42).ok).toBe(true);
  });

  it('validate fails for boolean (neither branch matches)', () => {
    expect(validate(schema, true).ok).toBe(false);
  });

  it('oneOf field inside object round-trips (T10 + W1 composition)', () => {
    const objSchema = t.object({
      value: t.oneOf([t.string(), t.number()] as const),
      tag: t.string(),
    });
    const encodedStr = encode(objSchema, { value: 'hello', tag: 'x' }) as {
      value: unknown;
      tag: string;
    };
    expect((encodedStr.value as { '@k': number })['@k']).toBe(0);
    const decodedStr = decode(objSchema, encodedStr) as { value: unknown; tag: string };
    expect(decodedStr.value).toBe('hello');

    const encodedNum = encode(objSchema, { value: 99, tag: 'y' }) as {
      value: unknown;
      tag: string;
    };
    expect((encodedNum.value as { '@k': number })['@k']).toBe(1);
    const decodedNum = decode(objSchema, encodedNum) as { value: unknown; tag: string };
    expect(decodedNum.value).toBe(99);
  });

  it('first-match-by-validate: number also matches a "number|string" schema at opt 0 position', () => {
    // When number is option 0, it matches before string can
    const reversedSchema = t.oneOf([t.number(), t.string()] as const);
    const wire = encode(reversedSchema, 5) as { '@k': number; '@v': unknown };
    expect(wire['@k']).toBe(0); // number is first
  });
});
