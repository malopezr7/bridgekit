import { memberHashes, stableHash } from '../hash';
import { defineContract, t } from '../index';

describe('stableHash – deterministic and stable', () => {
  it('produces same hash regardless of object key order', () => {
    const a = stableHash({ z: 1, a: 2, m: 3 });
    const b = stableHash({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
  });

  it('changes hash when value changes', () => {
    const a = stableHash({ key: 'value1' });
    const b = stableHash({ key: 'value2' });
    expect(a).not.toBe(b);
  });

  it('produces an 8-char hex string (FNV-1a 32-bit)', () => {
    const h = stableHash({ x: 1 });
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles nested objects with key sorting', () => {
    const a = stableHash({ b: { z: 1, a: 2 }, a: { z: 1, a: 2 } });
    const b = stableHash({ a: { a: 2, z: 1 }, b: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('handles arrays (order preserved)', () => {
    const a = stableHash({ arr: [1, 2, 3] });
    const b = stableHash({ arr: [3, 2, 1] });
    expect(a).not.toBe(b);
  });
});

describe('contract hash – integration', () => {
  it('same contract definition produces same hash', () => {
    const c1 = defineContract('test.hash', {
      methods: { ping: t.fire() },
    });
    const c2 = defineContract('test.hash', {
      methods: { ping: t.fire() },
    });
    expect(c1.hash).toBe(c2.hash);
  });

  it('hash changes when a method is added', () => {
    const c1 = defineContract('test.hash', {
      methods: { ping: t.fire() },
    });
    const c2 = defineContract('test.hash', {
      methods: { ping: t.fire(), pong: t.fire() },
    });
    expect(c1.hash).not.toBe(c2.hash);
  });

  it('hash changes when a state initial value changes', () => {
    const c1 = defineContract('test.hash', {
      state: { count: t.state(t.number(), 0) },
    });
    const c2 = defineContract('test.hash', {
      state: { count: t.state(t.number(), 99) },
    });
    expect(c1.hash).not.toBe(c2.hash);
  });

  it('hash changes when a stream schema changes', () => {
    const c1 = defineContract('test.hash', {
      streams: { events: t.stream(t.string()) },
    });
    const c2 = defineContract('test.hash', {
      streams: { events: t.stream(t.number()) },
    });
    expect(c1.hash).not.toBe(c2.hash);
  });
});

describe('memberHashes – per-member granularity', () => {
  it('returns keys with path prefixes methods./streams./state.', () => {
    const c = defineContract('test.members', {
      methods: { ping: t.fire(), getData: t.query(t.string()) },
      streams: { events: t.stream(t.number()) },
      state: { count: t.state(t.number(), 0) },
    });
    const mh = memberHashes(c.descriptor);
    expect('methods.ping' in mh).toBe(true);
    expect('methods.getData' in mh).toBe(true);
    expect('streams.events' in mh).toBe(true);
    expect('state.count' in mh).toBe(true);
  });

  it('each member hash is an 8-char hex string', () => {
    const c = defineContract('test.members', {
      methods: { ping: t.fire() },
    });
    const mh = memberHashes(c.descriptor);
    const hash = mh['methods.ping'];
    expect(hash).toBeDefined();
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('changing one member changes only that member hash', () => {
    const c1 = defineContract('test.members', {
      methods: { ping: t.fire(), pong: t.query(t.string()) },
    });
    const c2 = defineContract('test.members', {
      methods: { ping: t.fire(), pong: t.query(t.number()) }, // pong result changes
    });
    const mh1 = memberHashes(c1.descriptor);
    const mh2 = memberHashes(c2.descriptor);
    // ping unchanged
    expect(mh1['methods.ping']).toBe(mh2['methods.ping']);
    // pong changed
    expect(mh1['methods.pong']).not.toBe(mh2['methods.pong']);
  });

  it('returns empty object for contract with no members', () => {
    const c = defineContract('empty.contract', {});
    expect(Object.keys(memberHashes(c.descriptor))).toHaveLength(0);
  });
});
