import { decode, encode, sanitizeAny, validate } from '../codec';
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

describe('codec_web_oneof_unmatched_object_throws_at_encode', () => {
  const schema = t.oneOf([t.string(), t.number()] as const);

  it('throws while encoding an object that matches no oneOf option', () => {
    expect(() => encode(schema, { kind: 'not-a-string-or-number' })).toThrow(/oneOf/i);
  });

  it('throws while decoding an envelope whose value does not match the selected option', () => {
    expect(() => decode(schema, { '@k': 0, '@v': { unsafe: true } })).toThrow(/oneOf/i);
  });
});

describe('codec_web_optional_array_and_tuple_preserve_positions', () => {
  it('encodes optional array gaps as null without shifting later elements', () => {
    const schema = t.array(t.optional(t.string()));
    const wire = encode(schema, ['first', undefined, 'third']) as unknown[];

    expect(wire).toEqual(['first', null, 'third']);
    expect(wire).toHaveLength(3);
    expect(decode(schema, wire)).toEqual(['first', undefined, 'third']);
  });

  it('encodes optional tuple holes as null without changing tuple arity', () => {
    const schema = t.tuple([t.string(), t.optional(t.number()), t.string()] as const);
    const wire = encode(schema, ['left', undefined, 'right'] as const) as unknown[];

    expect(wire).toEqual(['left', null, 'right']);
    expect(wire).toHaveLength(3);
    expect(decode(schema, wire)).toEqual(['left', undefined, 'right']);
  });

  it('pins optional(nullable(T)) collection null/undefined collapse as native parity', () => {
    const schema = t.array(t.optional(t.nullable(t.number())));
    const wire = encode(schema, [null, undefined, 1]) as unknown[];

    expect(wire).toEqual([null, null, 1]);
    expect(decode(schema, wire)).toEqual([undefined, undefined, 1]);
  });
});

describe('codec_web_oneof_literal_enum_strictness_pin', () => {
  it('keeps bare literal decode skew-tolerant while oneOf literal decode is strict', () => {
    const literalSchema = t.literals('known');

    expect(decode(literalSchema, 'skewed')).toBe('skewed');
    // Deliberate asymmetry: oneOf validates the selected @v after decode so
    // skewed literal envelopes fail fast, matching native strict literals.
    expect(() => decode(t.oneOf([literalSchema] as const), { '@k': 0, '@v': 'skewed' })).toThrow(
      /oneOf/i,
    );
  });

  it('keeps bare enum decode skew-tolerant while oneOf enum decode is strict', () => {
    const enumSchema = t.enum({ Ready: 1 });

    expect(decode(enumSchema, 2)).toBe(2);
    // Deliberate asymmetry: oneOf validates the selected @v after decode so
    // skewed enum envelopes fail fast, matching native strict enums.
    expect(() => decode(t.oneOf([enumSchema] as const), { '@k': 0, '@v': 2 })).toThrow(/oneOf/i);
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

describe('codec_web_record_proto_payload_does_not_mutate_prototype', () => {
  const assertPrototypeSafe = (value: unknown): void => {
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.hasOwn(value as object, '__proto__')).toBe(false);
    expect(Object.hasOwn(value as object, 'constructor')).toBe(false);
    expect(Object.hasOwn(value as object, 'prototype')).toBe(false);
  };

  const assertObjectPrototypeUnpolluted = (): void => {
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).nestedPolluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).ctorPolluted).toBeUndefined();
  };

  it('decodes record payloads with guarded keys without installing them as prototypes', () => {
    const schema = t.record(t.json());
    const payload = JSON.parse(
      '{"safe":{"nested":true},"__proto__":{"polluted":"decoded"},"constructor":{"polluted":"ctor"},"prototype":{"polluted":"prototype"}}',
    ) as Record<string, unknown>;

    const decoded = decode(schema, payload) as Record<string, unknown>;

    assertPrototypeSafe(decoded);
    expect(decoded.safe).toEqual({ nested: true });
    expect((decoded as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('sanitizes json payloads with guarded keys without installing them as prototypes', () => {
    const payload = JSON.parse(
      '{"safe":{"nested":true},"__proto__":{"polluted":"json"},"constructor":{"polluted":"ctor"},"prototype":{"polluted":"prototype"}}',
    ) as Record<string, unknown>;

    const sanitized = sanitizeAny(payload) as Record<string, unknown>;
    const encoded = encode(t.json(), payload) as Record<string, unknown>;

    assertPrototypeSafe(sanitized);
    assertPrototypeSafe(encoded);
    expect(sanitized.safe).toEqual({ nested: true });
    expect(encoded.safe).toEqual({ nested: true });
    expect((sanitized as { polluted?: unknown }).polluted).toBeUndefined();
    expect((encoded as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('decodes nested json record values with null prototypes and stripped guarded keys', () => {
    const schema = t.record(t.json());
    const payload = JSON.parse(
      '{"safe":{"keep":true,"__proto__":{"nestedPolluted":1},"constructor":{"prototype":{"ctorPolluted":1}},"prototype":{"polluted":2}},"list":[{"keep":"array","__proto__":{"nestedPolluted":2},"constructor":{"prototype":{"ctorPolluted":2}},"prototype":{"polluted":3}}],"__proto__":{"polluted":1},"constructor":{"prototype":{"ctorPolluted":1}},"prototype":{"polluted":2}}',
    ) as Record<string, unknown>;

    const decoded = decode(schema, payload) as Record<string, unknown>;

    assertPrototypeSafe(decoded);
    assertObjectPrototypeUnpolluted();

    const safe = decoded.safe as Record<string, unknown>;
    assertPrototypeSafe(safe);
    expect(safe.keep).toBe(true);
    expect(safe.nestedPolluted).toBeUndefined();
    expect(safe.ctorPolluted).toBeUndefined();
    expect(safe.polluted).toBeUndefined();

    const list = decoded.list as unknown[];
    expect(Array.isArray(list)).toBe(true);
    const listItem = list[0] as Record<string, unknown>;
    assertPrototypeSafe(listItem);
    expect(listItem.keep).toBe('array');
    expect(listItem.nestedPolluted).toBeUndefined();
    expect(listItem.ctorPolluted).toBeUndefined();
    expect(listItem.polluted).toBeUndefined();
  });

  it('decodes bare json values with nested null-proto objects and stripped guarded keys', () => {
    const payload = JSON.parse(
      '{"safe":{"keep":true,"__proto__":{"nestedPolluted":1},"constructor":{"prototype":{"ctorPolluted":1}},"prototype":{"polluted":2}},"list":[{"keep":"array","__proto__":{"nestedPolluted":2},"constructor":{"prototype":{"ctorPolluted":2}},"prototype":{"polluted":3}}],"__proto__":{"polluted":1},"constructor":{"prototype":{"ctorPolluted":1}},"prototype":{"polluted":2}}',
    ) as Record<string, unknown>;

    const decoded = decode(t.json(), payload) as Record<string, unknown>;

    assertPrototypeSafe(decoded);
    assertObjectPrototypeUnpolluted();

    const safe = decoded.safe as Record<string, unknown>;
    assertPrototypeSafe(safe);
    expect(safe.keep).toBe(true);
    expect(safe.nestedPolluted).toBeUndefined();
    expect(safe.ctorPolluted).toBeUndefined();
    expect(safe.polluted).toBeUndefined();

    const list = decoded.list as unknown[];
    expect(Array.isArray(list)).toBe(true);
    const listItem = list[0] as Record<string, unknown>;
    assertPrototypeSafe(listItem);
    expect(listItem.keep).toBe('array');
    expect(listItem.nestedPolluted).toBeUndefined();
    expect(listItem.ctorPolluted).toBeUndefined();
    expect(listItem.polluted).toBeUndefined();
  });

  it('preserves legitimate json values through encode-decode round trips', () => {
    const payload = {
      nested: { keep: true, count: 3 },
      list: [1, { name: 'two' }, null, false],
      text: 'ok',
    };

    const decoded = decode(t.json(), payload);
    const encoded = encode(t.json(), decoded);

    expect(encoded).toEqual(payload);
    expect((encoded as { list: unknown[] }).list).toEqual([1, { name: 'two' }, null, false]);
  });
});

describe('codec_web_decode_tolerant_passthrough_sanitizes_reserved_own_keys', () => {
  const payloadWithReservedKeys = (): Record<string, unknown> =>
    JSON.parse(
      '{"__proto__":{"polluted":1},"constructor":{"polluted":2},"prototype":{"polluted":3},"keep":true,"nested":{"__proto__":{"polluted":4},"keep":"nested"}}',
    ) as Record<string, unknown>;

  const arrayWithReservedObject = (): unknown[] =>
    JSON.parse(
      '[{"__proto__":{"polluted":1},"constructor":{"polluted":2},"prototype":{"polluted":3},"keep":"array"}]',
    ) as unknown[];

  const expectReservedKeysStripped = (value: unknown): void => {
    expect(Object.hasOwn(value as object, '__proto__')).toBe(false);
    expect(Object.hasOwn(value as object, 'constructor')).toBe(false);
    expect(Object.hasOwn(value as object, 'prototype')).toBe(false);
  };

  it('throws for oneOf primitive option @v object mismatches instead of passthrough', () => {
    expect(() =>
      decode(t.oneOf([t.string()] as const), {
        '@k': 0,
        '@v': payloadWithReservedKeys(),
      }),
    ).toThrow(/oneOf/i);
  });

  it.each([
    ['string', t.string()],
    ['number', t.number()],
    ['boolean', t.boolean()],
    ['void', t.void()],
  ] as const)('sanitizes %s schema object mismatch passthrough', (_name, schema) => {
    const result = decode(schema, payloadWithReservedKeys()) as Record<string, unknown>;

    expectReservedKeysStripped(result);
    expect(result.keep).toBe(true);
  });

  it('sanitizes literals skew object passthrough', () => {
    const result = decode(t.literals('allowed'), payloadWithReservedKeys()) as Record<
      string,
      unknown
    >;

    expectReservedKeysStripped(result);
    expect(result.keep).toBe(true);
  });

  it('sanitizes enum skew object passthrough', () => {
    const result = decode(t.enum({ Known: 1 }), payloadWithReservedKeys()) as Record<
      string,
      unknown
    >;

    expectReservedKeysStripped(result);
    expect(result.keep).toBe(true);
  });

  it('sanitizes array schema object mismatch passthrough', () => {
    const result = decode(t.array(t.string()), payloadWithReservedKeys()) as Record<
      string,
      unknown
    >;

    expectReservedKeysStripped(result);
    expect(result.keep).toBe(true);
  });

  it.each([
    ['object', t.object({ keep: t.string() })],
    ['record', t.record(t.string())],
    ['union non-object', t.union('kind', { ok: t.object({ keep: t.string() }) })],
  ] as const)('sanitizes %s schema array mismatch passthrough while preserving arrays', (_name, schema) => {
    const result = decode(schema, arrayWithReservedObject()) as unknown[];

    expect(Array.isArray(result)).toBe(true);
    expectReservedKeysStripped(result[0]);
    expect((result[0] as Record<string, unknown>).keep).toBe('array');
  });

  it('sanitizes tuple schema object mismatch passthrough', () => {
    const result = decode(t.tuple([t.string()] as const), payloadWithReservedKeys()) as Record<
      string,
      unknown
    >;

    expectReservedKeysStripped(result);
    expect(result.keep).toBe(true);
  });

  it.each([
    ['non-string discriminant', { kind: 1, ...payloadWithReservedKeys() }],
    ['unknown variant', { kind: 'missing', ...payloadWithReservedKeys() }],
  ] as const)('sanitizes union %s passthrough', (_name, payload) => {
    const result = decode(
      t.union('kind', { ok: t.object({ keep: t.boolean() }) }),
      payload,
    ) as Record<string, unknown>;

    expectReservedKeysStripped(result);
    expect(result.keep).toBe(true);
  });

  it('throws for oneOf non-envelope arrays instead of passthrough', () => {
    expect(() => decode(t.oneOf([t.string()] as const), arrayWithReservedObject())).toThrow(
      /oneOf/i,
    );
  });

  it('preserves reserved words when they are primitive string values', () => {
    expect(decode(t.string(), '__proto__')).toBe('__proto__');
  });

  it('preserves legitimate similar data keys inside decoded objects', () => {
    const result = decode(t.json(), {
      constructorName: 'Widget',
      prototypeChain: 'BaseWidget',
    }) as Record<string, unknown>;

    expect(result.constructorName).toBe('Widget');
    expect(result.prototypeChain).toBe('BaseWidget');
  });

  it('preserves arrays as arrays when sanitizing passthrough values', () => {
    const result = decode(t.record(t.string()), arrayWithReservedObject()) as unknown[];

    expect(Array.isArray(result)).toBe(true);
    expect((result[0] as Record<string, unknown>).keep).toBe('array');
  });

  it('keeps encode(decode(value)) lossless for legitimate nested json data', () => {
    const payload = {
      object: { constructorName: 'Widget', prototypeChain: 'BaseWidget' },
      array: [1, { keep: true }, null, false, 'text'],
      primitive: 'value',
      nothing: null,
      emptyObject: {},
      emptyArray: [],
    };

    const decoded = decode(t.json(), payload);
    const encoded = encode(t.json(), decoded);

    expect(encoded).toEqual(payload);
  });
});

describe('codec_web_decode_typed_value_passthrough_strips_reserved_own_keys', () => {
  const addReservedOwnKeys = <T extends object>(value: T): T => {
    Object.defineProperty(value, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { polluted: 'proto' },
    });
    Object.defineProperty(value, 'constructor', {
      configurable: true,
      enumerable: true,
      value: { polluted: 'constructor' },
    });
    Object.defineProperty(value, 'prototype', {
      configurable: true,
      enumerable: true,
      value: { polluted: 'prototype' },
    });
    return value;
  };

  const expectNoReservedOwnKeys = (value: object): void => {
    expect(Object.hasOwn(value, '__proto__')).toBe(false);
    expect(Object.hasOwn(value, 'constructor')).toBe(false);
    expect(Object.hasOwn(value, 'prototype')).toBe(false);
  };

  it('clones Date typed fallback values and strips reserved own keys', () => {
    const input = addReservedOwnKeys(new Date('2025-06-14T12:00:00.000Z'));

    const result = decode(t.date(), input) as Date;

    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(input.getTime());
    expectNoReservedOwnKeys(result);
    expect(result).not.toBe(input);
  });

  it('clones Uint8Array typed fallback values and strips reserved own keys', () => {
    const input = addReservedOwnKeys(new Uint8Array([0x01, 0x02, 0xff]));

    const result = decode(t.binary(), input) as Uint8Array;

    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([0x01, 0x02, 0xff]);
    expectNoReservedOwnKeys(result);
    expect(result).not.toBe(input);
  });

  it('keeps typed value semantics through declared containers without corruption', () => {
    const dateInput = addReservedOwnKeys(new Date('2025-06-14T12:00:00.000Z'));
    const binaryInput = addReservedOwnKeys(new Uint8Array([0x0a, 0x0b]));
    const int64Input = 9007199254740993n;

    const objectResult = decode(t.object({ at: t.date(), bytes: t.binary(), count: t.int64() }), {
      at: dateInput,
      bytes: binaryInput,
      count: int64Input,
    }) as { at: Date; bytes: Uint8Array; count: bigint };
    const arrayResult = decode(t.array(t.date()), [dateInput]) as Date[];
    const recordResult = decode(t.record(t.binary()), { payload: binaryInput }) as Record<
      string,
      Uint8Array
    >;
    const tupleResult = decode(t.tuple([t.date(), t.binary(), t.int64()] as const), [
      dateInput,
      binaryInput,
      int64Input,
    ]) as [Date, Uint8Array, bigint];
    const oneOfDate = decode(t.oneOf([t.date(), t.binary(), t.int64()] as const), {
      '@k': 0,
      '@v': dateInput,
    }) as Date;
    const oneOfBinary = decode(t.oneOf([t.date(), t.binary(), t.int64()] as const), {
      '@k': 1,
      '@v': binaryInput,
    }) as Uint8Array;
    const oneOfInt64 = decode(t.oneOf([t.date(), t.binary(), t.int64()] as const), {
      '@k': 2,
      '@v': int64Input,
    }) as bigint;

    expect(objectResult.at).toBeInstanceOf(Date);
    expect(objectResult.at.getTime()).toBe(dateInput.getTime());
    expectNoReservedOwnKeys(objectResult.at);
    expect(Array.from(objectResult.bytes)).toEqual([0x0a, 0x0b]);
    expectNoReservedOwnKeys(objectResult.bytes);
    expect(objectResult.count).toBe(int64Input);

    expect(arrayResult[0]).toBeInstanceOf(Date);
    expect(arrayResult[0].getTime()).toBe(dateInput.getTime());
    expectNoReservedOwnKeys(arrayResult[0]);

    expect(Array.from(recordResult.payload)).toEqual([0x0a, 0x0b]);
    expectNoReservedOwnKeys(recordResult.payload);

    expect(tupleResult[0].getTime()).toBe(dateInput.getTime());
    expectNoReservedOwnKeys(tupleResult[0]);
    expect(Array.from(tupleResult[1])).toEqual([0x0a, 0x0b]);
    expectNoReservedOwnKeys(tupleResult[1]);
    expect(tupleResult[2]).toBe(int64Input);

    expect(oneOfDate.getTime()).toBe(dateInput.getTime());
    expectNoReservedOwnKeys(oneOfDate);
    expect(Array.from(oneOfBinary)).toEqual([0x0a, 0x0b]);
    expectNoReservedOwnKeys(oneOfBinary);
    expect(oneOfInt64).toBe(int64Input);
  });
});

describe('codec_web_sanitize_any_preserves_special_values_and_rejects_cycles', () => {
  const addReservedOwnKeys = <T extends object>(value: T): T => {
    Object.defineProperty(value, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { polluted: 'proto' },
    });
    Object.defineProperty(value, 'constructor', {
      configurable: true,
      enumerable: true,
      value: { polluted: 'constructor' },
    });
    Object.defineProperty(value, 'prototype', {
      configurable: true,
      enumerable: true,
      value: { polluted: 'prototype' },
    });
    return value;
  };

  const expectNoReservedOwnKeys = (value: object): void => {
    expect(Object.hasOwn(value, '__proto__')).toBe(false);
    expect(Object.hasOwn(value, 'constructor')).toBe(false);
    expect(Object.hasOwn(value, 'prototype')).toBe(false);
  };

  it('preserves special values as fresh sanitized instances inside t.json values', () => {
    const date = addReservedOwnKeys(new Date('2025-06-14T12:00:00.000Z'));
    const bytes = addReservedOwnKeys(new Uint8Array([0x01, 0x02, 0xff]));
    const map = addReservedOwnKeys(
      new Map<string, unknown>([
        [
          'nested',
          JSON.parse(
            '{"keep":true,"__proto__":{"polluted":1},"constructor":{"polluted":2},"prototype":{"polluted":3}}',
          ),
        ],
      ]),
    );
    const set = addReservedOwnKeys(
      new Set<unknown>([
        JSON.parse(
          '{"keep":"set","__proto__":{"polluted":1},"constructor":{"polluted":2},"prototype":{"polluted":3}}',
        ),
      ]),
    );

    const sanitized = encode(t.json(), { date, bytes, map, set }) as {
      date: Date;
      bytes: Uint8Array;
      map: Map<string, Record<string, unknown>>;
      set: Set<Record<string, unknown>>;
    };

    expect(sanitized.date).toBeInstanceOf(Date);
    expect(sanitized.date.getTime()).toBe(date.getTime());
    expect(sanitized.date).not.toBe(date);
    expectNoReservedOwnKeys(sanitized.date);

    expect(sanitized.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(sanitized.bytes)).toEqual([0x01, 0x02, 0xff]);
    expect(sanitized.bytes).not.toBe(bytes);
    expectNoReservedOwnKeys(sanitized.bytes);

    expect(sanitized.map).toBeInstanceOf(Map);
    expect(sanitized.map).not.toBe(map);
    const mapValue = sanitized.map.get('nested') as Record<string, unknown>;
    expect(Object.getPrototypeOf(mapValue)).toBeNull();
    expect(mapValue.keep).toBe(true);
    expectNoReservedOwnKeys(mapValue);

    expect(sanitized.set).toBeInstanceOf(Set);
    expect(sanitized.set).not.toBe(set);
    const [setValue] = Array.from(sanitized.set);
    expect(Object.getPrototypeOf(setValue)).toBeNull();
    expect(setValue.keep).toBe('set');
    expectNoReservedOwnKeys(setValue);
  });

  it('rejects cyclic json values with a codec cycle error instead of stack overflow', () => {
    const cyclic: Record<string, unknown> = { keep: true };
    cyclic.self = cyclic;

    expect(() => sanitizeAny(cyclic)).toThrow(/cycle/i);
    expect(() => encode(t.json(), cyclic)).toThrow(/cycle/i);
  });

  it('allows object diamond references through sanitize and json decode paths', () => {
    const shared = { x: 1 };
    const payload = { a: shared, b: shared };

    expect(() => sanitizeAny(payload)).not.toThrow();
    expect(() => decode(t.json(), payload)).not.toThrow();

    expect(sanitizeAny(payload)).toEqual({ a: { x: 1 }, b: { x: 1 } });
    expect(decode(t.json(), payload)).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it('allows shared array container diamonds through the json encode and decode paths', () => {
    const shared = [1, 2];
    const payload = { a: shared, b: shared };

    expect(() => encode(t.json(), payload)).not.toThrow();
    expect(() => decode(t.json(), payload)).not.toThrow();

    expect(encode(t.json(), payload)).toEqual({ a: [1, 2], b: [1, 2] });
    expect(decode(t.json(), payload)).toEqual({ a: [1, 2], b: [1, 2] });
  });

  it('allows shared Map container diamonds through the json encode and decode paths', () => {
    const shared = new Map<string, string>([['k', 'v']]);
    const payload = { a: shared, b: shared };

    expect(() => encode(t.json(), payload)).not.toThrow();
    expect(() => decode(t.json(), payload)).not.toThrow();

    const encoded = encode(t.json(), payload) as {
      a: Map<string, string>;
      b: Map<string, string>;
    };
    const decoded = decode(t.json(), payload) as {
      a: Map<string, string>;
      b: Map<string, string>;
    };
    expect(Array.from(encoded.a.entries())).toEqual([['k', 'v']]);
    expect(Array.from(encoded.b.entries())).toEqual([['k', 'v']]);
    expect(Array.from(decoded.a.entries())).toEqual([['k', 'v']]);
    expect(Array.from(decoded.b.entries())).toEqual([['k', 'v']]);
  });

  it('allows shared Set container diamonds through the json encode and decode paths', () => {
    const shared = new Set([1, 2]);
    const payload = { a: shared, b: shared };

    expect(() => encode(t.json(), payload)).not.toThrow();
    expect(() => decode(t.json(), payload)).not.toThrow();

    const encoded = encode(t.json(), payload) as {
      a: Set<number>;
      b: Set<number>;
    };
    const decoded = decode(t.json(), payload) as {
      a: Set<number>;
      b: Set<number>;
    };
    expect(Array.from(encoded.a.values())).toEqual([1, 2]);
    expect(Array.from(encoded.b.values())).toEqual([1, 2]);
    expect(Array.from(decoded.a.values())).toEqual([1, 2]);
    expect(Array.from(decoded.b.values())).toEqual([1, 2]);
  });

  it('allows array diamond references through the json encode path', () => {
    const shared = { x: 1 };

    expect(() => encode(t.json(), [shared, shared])).not.toThrow();
    expect(encode(t.json(), [shared, shared])).toEqual([{ x: 1 }, { x: 1 }]);
  });

  it('allows Map entries to share the same object value through the json encode path', () => {
    const shared = { x: 1 };
    const payload = new Map<string, unknown>([
      ['first', shared],
      ['second', shared],
    ]);

    expect(() => encode(t.json(), payload)).not.toThrow();

    const encoded = encode(t.json(), payload) as Map<string, Record<string, unknown>>;
    expect(encoded.get('first')).toEqual({ x: 1 });
    expect(encoded.get('second')).toEqual({ x: 1 });
  });

  it('allows Set contents to share objects with sibling branches through the json encode path', () => {
    const shared = { x: 1 };
    const payload = { set: new Set([shared]), sibling: shared };

    expect(() => encode(t.json(), payload)).not.toThrow();

    const encoded = encode(t.json(), payload) as {
      set: Set<Record<string, unknown>>;
      sibling: Record<string, unknown>;
    };
    expect(Array.from(encoded.set)).toEqual([{ x: 1 }]);
    expect(encoded.sibling).toEqual({ x: 1 });
  });
});

describe('codec_web_binary_nan_enum_edges_are_safe', () => {
  it('throws a binary/base64 codec error for malformed padding-only base64', () => {
    try {
      decode(t.binary(), '=');
      throw new Error('decode unexpectedly accepted malformed base64');
    } catch (error) {
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/base64|binary|codec/i);
    }
  });

  it('rejects NaN at validation so number JSON round trips cannot corrupt it to null', () => {
    const result = validate(t.number(), Number.NaN);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/number/i);
      expect(result.message).toMatch(/NaN/i);
    }
  });

  it('rejects infinities at validation so number JSON round trips cannot corrupt them to null', () => {
    for (const value of [Infinity, -Infinity]) {
      const result = validate(t.number(), value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toMatch(/finite number/i);
      }
    }
  });

  it('keeps finite number validation accepted across representative values', () => {
    for (const value of [0, -1, 3.14, Number.MAX_SAFE_INTEGER]) {
      expect(validate(t.number(), value).ok).toBe(true);
    }
  });

  it('keeps enum wire values numeric while rejecting unknown validation values', () => {
    const schema = t.enum({ Red: 0, Green: 1, Blue: 2 });

    expect(encode(schema, 1)).toBe(1);
    expect(decode(schema, 1)).toBe(1);
    expect(validate(schema, 1).ok).toBe(true);
    expect(validate(schema, 99).ok).toBe(false);
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
