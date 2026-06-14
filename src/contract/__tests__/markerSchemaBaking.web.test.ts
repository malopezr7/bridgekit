// W3 — Schema-first markers: descriptor byte-identity proof.
//
// These tests assert that schema-first markers (design D1) produce descriptors
// that are byte-identical to the equivalent t.* descriptor for the same shapes.
// No generatedSchemas third-argument is required — the schemas are carried directly.
//
// ADR-7 (W3): schema-first markers make hash parity structural — the descriptor
// IS the t.* descriptor, so the CLI hash and the runtime hash are always identical.

import { Async, defineContract, State, Stream, stableHash, Void } from '../index';
import { t } from '../schema';

// ---- schema-first marker contract (no third arg needed) --------------------

function makeContract() {
  return defineContract('wave1.fixture', {
    methods: {
      getUserById: Async(
        t.object({ id: t.string() }),
        t.object({ userId: t.string(), name: t.string() }),
      ),
      ping: Void(),
    },
    streams: {
      tick: Stream(t.object({ n: t.number() })),
    },
    state: {
      status: State(t.string(), 'idle'),
    },
  });
}

describe('W3 schema-first markers — descriptor byte-identity', () => {
  it('carries the param/result schema into method descriptors directly', () => {
    const contract = makeContract();
    const getUserById = contract.descriptor.methods.getUserById;
    expect(getUserById.params).toEqual({
      kind: 'object',
      fields: { id: { kind: 'string' } },
    });
    expect((getUserById as { result?: unknown }).result).toEqual({
      kind: 'object',
      fields: { userId: { kind: 'string' }, name: { kind: 'string' } },
    });
  });

  it('carries the value schema into stream and state descriptors directly', () => {
    const contract = makeContract();
    expect(contract.descriptor.streams.tick.value).toEqual({
      kind: 'object',
      fields: { n: { kind: 'number' } },
    });
    expect(contract.descriptor.state.status.value).toEqual({ kind: 'string' });
  });

  it('preserves the initial value on state descriptors', () => {
    const contract = makeContract();
    expect(contract.descriptor.state.status.initial).toBe('idle');
  });

  it('hash is byte-identical to an equivalent t.* contract descriptor', () => {
    const contract = makeContract();

    // Build the equivalent descriptor using t.* directly (the reference shape).
    const tStarDescriptor = {
      $type: 'io.github.malopezr7.bridgekit.contract',
      descriptorVersion: 1,
      id: 'wave1.fixture',
      methods: {
        getUserById: {
          kind: 'query',
          params: { kind: 'object', fields: { id: { kind: 'string' } } },
          result: {
            kind: 'object',
            fields: { userId: { kind: 'string' }, name: { kind: 'string' } },
          },
        },
        ping: { kind: 'fire' },
      },
      streams: {
        tick: { kind: 'stream', value: { kind: 'object', fields: { n: { kind: 'number' } } } },
      },
      state: {
        status: { kind: 'state', value: { kind: 'string' }, initial: 'idle' },
      },
    };

    expect(contract.hash).toBe(stableHash(tStarDescriptor));
  });

  it('no-param Void marker hashes differently from a typed Async marker', () => {
    const a = defineContract('skew.a', { methods: { ping: Void() } });
    const b = defineContract('skew.a', {
      methods: {
        ping: Async(t.object({ id: t.string() }), t.object({ ok: t.boolean() })),
      },
    });
    expect(a.hash).not.toBe(b.hash);
  });

  it('schema-first State carries schema in descriptor — no generatedSchemas needed', () => {
    const contract = defineContract('state.fixture', {
      state: {
        count: State(t.number(), 0),
        label: State(t.string(), 'hello'),
      },
    });
    expect(contract.descriptor.state.count.value).toEqual({ kind: 'number' });
    expect(contract.descriptor.state.count.initial).toBe(0);
    expect(contract.descriptor.state.label.value).toEqual({ kind: 'string' });
    expect(contract.descriptor.state.label.initial).toBe('hello');
  });
});

// W4: .bridge.ts files deleted — schema-first contracts carry schemas directly.
// The W1(b) copy-parity gate is removed as the files no longer exist.
