// ---------------------------------------------------------------------------
// B5 hardening tests — WU-6
//
// 5.1-5.3: oneOf decode — missing @v and out-of-range @k throw descriptively.
// 5.4-5.5: boundaryDecode fail-fast — type mismatch throws instead of silent default.
// 5.6: nullable/optional — null envelope { @k:0, @v:null } decoded correctly.
// 5.7: dispatcher _openProducers leak in catch path.
// 5.8: registry.ts grace dead-code (pendingCallers never populated → safe remove).
// 5.9: contractHook getSnapshot cache-mutation — getSnapshot must be pure (stable ref).
// ---------------------------------------------------------------------------

import { describe, expect, it } from '@jest/globals';
import { decode, encode } from '../codec';
import { t } from '../schema';

// ---------------------------------------------------------------------------
// 5.1 – oneOf decode: missing @v field throws a descriptive error
// ---------------------------------------------------------------------------

describe('5.1 oneOf decode: missing @v throws descriptively', () => {
  const schema = t.oneOf([t.string(), t.number()] as const);

  it('throws when @v is absent from the envelope', () => {
    // Wire envelope with valid @k but no @v property at all
    expect(() => decode(schema, { '@k': 0 })).toThrow(/@v/);
  });

  it('error message names the schema kind', () => {
    expect(() => decode(schema, { '@k': 0 })).toThrow(/oneOf/i);
  });
});

// ---------------------------------------------------------------------------
// 5.2 – oneOf decode: @k present but not a number throws descriptively
// ---------------------------------------------------------------------------

describe('5.2 oneOf decode: non-numeric @k throws descriptively', () => {
  const schema = t.oneOf([t.string(), t.number()] as const);

  it('throws when @k is a string instead of number', () => {
    expect(() => decode(schema, { '@k': 'zero', '@v': 'hello' })).toThrow(/@k/);
  });

  it('throws when @k is undefined', () => {
    expect(() => decode(schema, { '@v': 'hello' })).toThrow(/@k/);
  });
});

// ---------------------------------------------------------------------------
// 5.3 – oneOf decode: out-of-range @k throws descriptively
// ---------------------------------------------------------------------------

describe('5.3 oneOf decode: out-of-range @k throws descriptively', () => {
  const schema = t.oneOf([t.string(), t.number()] as const);

  it('throws when @k is negative', () => {
    expect(() => decode(schema, { '@k': -1, '@v': 'hello' })).toThrow(/-1/);
  });

  it('throws when @k equals options.length', () => {
    expect(() => decode(schema, { '@k': 2, '@v': 'hello' })).toThrow(/2/);
  });

  it('throws when @k is out of range and error mentions "out of range" or the index', () => {
    expect(() => decode(schema, { '@k': 99, '@v': 'hello' })).toThrow(/99/);
  });
});

// ---------------------------------------------------------------------------
// 5.6 – nullable/optional: null inside oneOf variant decodes correctly
// Regression: decode(nullable(oneOf([string, number])), null) must return null
// not throw.
// ---------------------------------------------------------------------------

describe('5.6 nullable/optional: null guard for union variants', () => {
  const nullableOneOf = t.nullable(t.oneOf([t.string(), t.number()] as const));
  const optionalOneOf = t.optional(t.oneOf([t.string(), t.number()] as const));

  it('nullable(oneOf): null → null (must not throw)', () => {
    expect(decode(nullableOneOf, null)).toBeNull();
  });

  it('optional(oneOf): undefined → undefined (must not throw)', () => {
    expect(decode(optionalOneOf, undefined)).toBeUndefined();
  });

  it('nullable(oneOf): valid envelope decoded correctly after null guard', () => {
    const result = decode(nullableOneOf, { '@k': 0, '@v': 'hello' });
    expect(result).toBe('hello');
  });

  it('optional(oneOf): valid envelope decoded correctly after null guard', () => {
    const result = decode(optionalOneOf, { '@k': 1, '@v': 42 });
    expect(result).toBe(42);
  });
});

describe('4.1 oneOf fail-fast symmetry', () => {
  const schema = t.oneOf([t.string(), t.number()] as const);

  it('encode throws before sending an unmatched object to the peer', () => {
    expect(() => encode(schema, { unsafe: true })).toThrow(/oneOf/i);
  });

  it('decode throws when the selected branch cannot decode the envelope value', () => {
    expect(() => decode(schema, { '@k': 0, '@v': { unsafe: true } })).toThrow(/oneOf/i);
  });
});

describe('4.1 optional collection position preservation', () => {
  it('array optional elements round-trip null positionally without index shifts', () => {
    const schema = t.array(t.optional(t.number()));
    const wire = encode(schema, [1, undefined, 3]) as unknown[];

    expect(wire).toEqual([1, null, 3]);
    expect(decode(schema, wire)).toEqual([1, undefined, 3]);
  });
});
