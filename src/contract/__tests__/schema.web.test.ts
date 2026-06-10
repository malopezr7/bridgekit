import { t } from '../schema';

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------
type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('t DSL – schema nodes are plain serializable objects', () => {
  it('t.string() has kind string', () => {
    const s = t.string();
    expect(s.kind).toBe('string');
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('t.number() has kind number', () => {
    expect(t.number().kind).toBe('number');
  });

  it('t.boolean() has kind boolean', () => {
    expect(t.boolean().kind).toBe('boolean');
  });

  it('t.void() has kind void', () => {
    expect(t.void().kind).toBe('void');
  });

  it('t.json() has kind json', () => {
    expect(t.json().kind).toBe('json');
  });

  it('t.literals() has kind literals and values array', () => {
    const l = t.literals('a', 'b', 'c');
    expect(l.kind).toBe('literals');
    expect(l.values).toEqual(['a', 'b', 'c']);
  });

  it('t.object() has kind object and fields', () => {
    const o = t.object({ x: t.string(), y: t.number() });
    expect(o.kind).toBe('object');
    expect(o.fields['x']?.kind).toBe('string');
    expect(o.fields['y']?.kind).toBe('number');
  });

  it('t.array() has kind array and item', () => {
    const a = t.array(t.string());
    expect(a.kind).toBe('array');
    expect(a.item.kind).toBe('string');
  });

  it('t.record() has kind record and value schema', () => {
    const r = t.record(t.number());
    expect(r.kind).toBe('record');
    expect(r.value.kind).toBe('number');
  });

  it('t.optional() has kind optional and inner', () => {
    const o = t.optional(t.string());
    expect(o.kind).toBe('optional');
    expect(o.inner.kind).toBe('string');
  });

  it('t.nullable() has kind nullable and inner', () => {
    const n = t.nullable(t.string());
    expect(n.kind).toBe('nullable');
    expect(n.inner.kind).toBe('string');
  });

  it('t.union() has kind union, discriminant, and variants', () => {
    const u = t.union('type', {
      a: t.object({ value: t.string() }),
      b: t.object({ count: t.number() }),
    });
    expect(u.kind).toBe('union');
    expect(u.discriminant).toBe('type');
    expect(Object.keys(u.variants)).toEqual(['a', 'b']);
  });

  it('t.union() throws if variants declare the discriminant key', () => {
    expect(() =>
      t.union('type', {
        a: t.object({ type: t.string(), value: t.string() }),
      }),
    ).toThrow();
  });

  it('schema nodes are JSON-serializable (no functions, no class instances)', () => {
    const schema = t.object({
      name: t.string(),
      tags: t.array(t.literals('a', 'b')),
      meta: t.nullable(t.record(t.number())),
    });
    const round = JSON.parse(JSON.stringify(schema));
    expect(round).toEqual(schema);
  });
});

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------
describe('t.Infer type inference', () => {
  it('infers string', () => {
    const schema = t.string();
    type Inferred = t.Infer<typeof schema>;
    type _check = Expect<Equal<Inferred, string>>;
    const val: Inferred = 'hello';
    expect(typeof val).toBe('string');
  });

  it('infers number', () => {
    const schema = t.number();
    type Inferred = t.Infer<typeof schema>;
    type _check = Expect<Equal<Inferred, number>>;
    const val: Inferred = 42;
    expect(typeof val).toBe('number');
  });

  it('infers boolean', () => {
    const schema = t.boolean();
    type Inferred = t.Infer<typeof schema>;
    type _check = Expect<Equal<Inferred, boolean>>;
    const val: Inferred = true;
    expect(typeof val).toBe('boolean');
  });

  it('infers void as undefined', () => {
    const schema = t.void();
    type Inferred = t.Infer<typeof schema>;
    type _check = Expect<Equal<Inferred, undefined>>;
    const val: Inferred = undefined;
    expect(val).toBeUndefined();
  });

  it('infers json as unknown', () => {
    const schema = t.json();
    type Inferred = t.Infer<typeof schema>;
    type _check = Expect<Equal<Inferred, unknown>>;
    // runtime: any value works
    expect(true).toBe(true);
  });

  it('infers literals as union of string literals', () => {
    const schema = t.literals('a', 'b', 'c');
    type Inferred = t.Infer<typeof schema>;
    type _check = Expect<Equal<Inferred, 'a' | 'b' | 'c'>>;
    const val: Inferred = 'a';
    expect(val).toBe('a');
  });

  it('infers optional as T | undefined', () => {
    const schema = t.optional(t.string());
    type Inferred = t.Infer<typeof schema>;
    type _check = Expect<Equal<Inferred, string | undefined>>;
    const val: Inferred = undefined;
    expect(val).toBeUndefined();
  });

  it('infers nullable as T | null', () => {
    const schema = t.nullable(t.string());
    type Inferred = t.Infer<typeof schema>;
    type _check = Expect<Equal<Inferred, string | null>>;
    const val: Inferred = null;
    expect(val).toBeNull();
  });

  it('infers object with typed fields', () => {
    const schema = t.object({ name: t.string(), age: t.number() });
    type Inferred = t.Infer<typeof schema>;
    type _check = Expect<Equal<Inferred, { name: string; age: number }>>;
    const val: Inferred = { name: 'Alice', age: 30 };
    expect(val.name).toBe('Alice');
  });

  it('infers array', () => {
    const schema = t.array(t.number());
    type Inferred = t.Infer<typeof schema>;
    type _check = Expect<Equal<Inferred, number[]>>;
    const val: Inferred = [1, 2, 3];
    expect(val).toHaveLength(3);
  });

  it('infers record', () => {
    const schema = t.record(t.boolean());
    type Inferred = t.Infer<typeof schema>;
    type _check = Expect<Equal<Inferred, Record<string, boolean>>>;
    const val: Inferred = { a: true };
    expect(val['a']).toBe(true);
  });

  it('infers union as discriminated union with discriminant included', () => {
    const schema = t.union('kind', {
      text: t.object({ content: t.string() }),
      number: t.object({ value: t.number() }),
    });
    type Inferred = t.Infer<typeof schema>;
    // discriminant key is injected per variant
    type _check = Expect<
      Equal<Inferred, { kind: 'text'; content: string } | { kind: 'number'; value: number }>
    >;
    const val: Inferred = { kind: 'text', content: 'hello' };
    expect(val.kind).toBe('text');
  });
});
