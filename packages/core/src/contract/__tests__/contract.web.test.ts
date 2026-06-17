import { defineContract, t } from '../index';

describe('defineContract – id validation', () => {
  it('accepts valid reverse-DNS-ish ids', () => {
    expect(() => defineContract('connect.host', {})).not.toThrow();
    expect(() => defineContract('lia.feature', {})).not.toThrow();
    expect(() => defineContract('example.widget.state', {})).not.toThrow();
    expect(() => defineContract('a1.b2-c', {})).not.toThrow();
  });

  it('rejects ids without a dot', () => {
    expect(() => defineContract('notsegments', {})).toThrow(/dot/i);
  });

  it('rejects ids starting with a number', () => {
    expect(() => defineContract('1bad.id', {})).toThrow();
  });

  it('rejects ids starting with uppercase', () => {
    expect(() => defineContract('Bad.id', {})).toThrow();
  });

  it('rejects empty id', () => {
    expect(() => defineContract('', {})).toThrow();
  });

  it('rejects ids with consecutive dots', () => {
    expect(() => defineContract('a..b', {})).toThrow();
  });

  it('rejects ids ending with a dot', () => {
    expect(() => defineContract('a.b.', {})).toThrow();
  });

  it('includes helpful message on failure', () => {
    expect(() => defineContract('BadId', {})).toThrow(/contract id/i);
  });
});

describe('defineContract – returned token', () => {
  it('returns a frozen object', () => {
    const c = defineContract('foo.bar', {});
    expect(Object.isFrozen(c)).toBe(true);
  });

  it('descriptor has correct $type and version', () => {
    const c = defineContract('foo.bar', {});
    expect(c.descriptor.$type).toBe('com.bridgekit.contract');
    expect(c.descriptor.descriptorVersion).toBe(1);
    expect(c.descriptor.id).toBe('foo.bar');
  });

  it('descriptor has empty methods/streams/state when none specified', () => {
    const c = defineContract('foo.bar', {});
    expect(c.descriptor.methods).toEqual({});
    expect(c.descriptor.streams).toEqual({});
    expect(c.descriptor.state).toEqual({});
  });

  it('descriptor includes methods/streams/state from shape', () => {
    const c = defineContract('foo.bar', {
      methods: {
        ping: t.fire(),
        getData: t.query(t.string()),
      },
      streams: {
        events: t.stream(t.number()),
      },
      state: {
        count: t.state(t.number(), 0),
      },
    });
    expect(c.descriptor.methods['ping']).toBeDefined();
    expect(c.descriptor.methods['getData']).toBeDefined();
    expect(c.descriptor.streams['events']).toBeDefined();
    expect(c.descriptor.state['count']).toBeDefined();
  });

  it('produces a stable hash string', () => {
    const c = defineContract('foo.bar', {
      methods: { ping: t.fire() },
    });
    expect(typeof c.hash).toBe('string');
    expect(c.hash.length).toBeGreaterThan(0);
  });

  it('same shape produces same hash', () => {
    const c1 = defineContract('foo.bar', { methods: { ping: t.fire() } });
    const c2 = defineContract('foo.bar', { methods: { ping: t.fire() } });
    expect(c1.hash).toBe(c2.hash);
  });

  it('different shape produces different hash', () => {
    const c1 = defineContract('foo.bar', { methods: { ping: t.fire() } });
    const c2 = defineContract('foo.bar', { methods: { pong: t.fire() } });
    expect(c1.hash).not.toBe(c2.hash);
  });
});

describe('defineContract – state initial value validation', () => {
  it('accepts valid initial values', () => {
    expect(() =>
      defineContract('foo.bar', {
        state: { count: t.state(t.number(), 0) },
      }),
    ).not.toThrow();

    expect(() =>
      defineContract('foo.bar', {
        state: { status: t.state(t.literals('idle', 'active'), 'idle') },
      }),
    ).not.toThrow();
  });

  it('throws when initial value does not match schema', () => {
    expect(() =>
      defineContract('foo.bar', {
        state: { count: t.state(t.number(), 'not-a-number' as unknown as number) },
      }),
    ).toThrow();
  });

  it('throws with a helpful message describing the mismatch', () => {
    expect(() =>
      defineContract('foo.bar', {
        state: { flag: t.state(t.boolean(), 'true' as unknown as boolean) },
      }),
    ).toThrow(/initial/i);
  });
});

describe('defineContract – union discriminant collision prevention', () => {
  it('throws if union variant declares discriminant key', () => {
    expect(() =>
      t.union('kind', {
        foo: t.object({ kind: t.string(), value: t.string() }),
      }),
    ).toThrow(/discriminant/i);
  });

  it('does not throw when variants do not declare the discriminant key', () => {
    expect(() =>
      t.union('kind', {
        foo: t.object({ value: t.string() }),
        bar: t.object({ count: t.number() }),
      }),
    ).not.toThrow();
  });
});

describe('t descriptor kinds', () => {
  it('t.fire() has kind fire', () => {
    expect(t.fire().kind).toBe('fire');
  });

  it('t.fire(params) stores params', () => {
    const d = t.fire(t.object({ url: t.string() }));
    expect(d.params?.kind).toBe('object');
  });

  it('t.query(result) — single arg = result only', () => {
    const d = t.query(t.string());
    expect(d.kind).toBe('query');
    expect(d.params).toBeUndefined();
    expect(d.result.kind).toBe('string');
  });

  it('t.query(params, result) — two args', () => {
    const d = t.query(t.object({ x: t.number() }), t.string());
    expect(d.kind).toBe('query');
    expect(d.params?.kind).toBe('object');
    expect(d.result.kind).toBe('string');
  });

  it('t.query(params, result, opts) — three args with timeoutMs', () => {
    const d = t.query(t.object({ x: t.number() }), t.string(), { timeoutMs: null });
    expect(d.timeoutMs).toBeNull();
  });

  it('t.querySync(result) — single arg', () => {
    const d = t.querySync(t.number());
    expect(d.kind).toBe('querySync');
    expect(d.params).toBeUndefined();
    expect(d.result.kind).toBe('number');
  });

  it('t.querySync(params, result) — two args', () => {
    const d = t.querySync(t.object({ id: t.string() }), t.number());
    expect(d.kind).toBe('querySync');
    expect(d.params?.kind).toBe('object');
  });

  it('t.stream(value) has kind stream', () => {
    const d = t.stream(t.string());
    expect(d.kind).toBe('stream');
    expect(d.value.kind).toBe('string');
  });

  it('t.stream(value, opts) stores opts', () => {
    const d = t.stream(t.string(), { latestOnly: true, sticky: true });
    expect(d.latestOnly).toBe(true);
    expect(d.sticky).toBe(true);
  });

  it('t.state(schema, initial) has kind state with initial', () => {
    const d = t.state(t.string(), 'hello');
    expect(d.kind).toBe('state');
    expect(d.value.kind).toBe('string');
    expect(d.initial).toBe('hello');
  });
});
