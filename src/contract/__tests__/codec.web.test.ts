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
