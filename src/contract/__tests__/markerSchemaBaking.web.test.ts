// Wave 1 keystone: marker descriptors carry resolved AnySchema (design Decision 1).
//
// These tests assert that defineContract(id, shape, generatedSchemas) bakes the
// resolved schemas into each descriptor member, and that the resulting runtime
// contractHash is byte-for-byte equal to the hash the CLI computes over the SAME
// descriptor structure (hash parity by construction).

import type { GeneratedSchemas } from '../index';
import { Async, defineContract, State, Stream, stableHash, Void } from '../index';

// Generated schemas as the CLI would emit them into *.bridge.ts for this contract.
const generatedSchemas: GeneratedSchemas = {
  methods: {
    getUserById: {
      params: { kind: 'object', fields: { id: { kind: 'string' } } },
      result: {
        kind: 'object',
        fields: {
          userId: { kind: 'string' },
          name: { kind: 'string' },
        },
      },
    },
    ping: {},
  },
  streams: {
    tick: { value: { kind: 'object', fields: { n: { kind: 'number' } } } },
  },
  state: {
    status: { value: { kind: 'string' } },
  },
};

function makeContract() {
  return defineContract(
    'wave1.fixture',
    {
      methods: {
        getUserById: Async<{ id: string }, { userId: string; name: string }>(),
        ping: Void(),
      },
      streams: {
        tick: Stream<{ n: number }>(),
      },
      state: {
        status: State('idle'),
      },
    },
    generatedSchemas,
  );
}

describe('Wave 1 keystone — marker schema baking', () => {
  it('bakes the resolved param/result schema into method descriptors', () => {
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

  it('bakes the resolved value schema into stream and state descriptors', () => {
    const contract = makeContract();
    expect(contract.descriptor.streams.tick.value).toEqual({
      kind: 'object',
      fields: { n: { kind: 'number' } },
    });
    expect(contract.descriptor.state.status.value).toEqual({ kind: 'string' });
  });

  it('preserves the marker initial value on state descriptors', () => {
    const contract = makeContract();
    expect(contract.descriptor.state.status.initial).toBe('idle');
  });

  it('produces a contractHash equal to the CLI hash over the same descriptor', () => {
    const contract = makeContract();

    // This is exactly the descriptor structure the CLI hashes (load.ts
    // markerDescriptorToToken → _stableHash over the full descriptor with schemas).
    const cliDescriptor = {
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

    expect(contract.hash).toBe(stableHash(cliDescriptor));
  });

  it('hashes a no-param Void marker differently from a typed Query marker', () => {
    const a = defineContract(
      'skew.a',
      { methods: { ping: Void() } },
      { methods: { ping: {} }, streams: {}, state: {} },
    );
    const b = defineContract(
      'skew.a',
      { methods: { ping: Async<{ id: string }, { ok: boolean }>() } },
      {
        methods: {
          ping: {
            params: { kind: 'object', fields: { id: { kind: 'string' } } },
            result: { kind: 'object', fields: { ok: { kind: 'boolean' } } },
          },
        },
        streams: {},
        state: {},
      },
    );
    expect(a.hash).not.toBe(b.hash);
  });

  it('still works without generatedSchemas (legacy schema-less marker path)', () => {
    const contract = defineContract('legacy.fixture', {
      methods: { ping: Void() },
      state: { status: State('idle') },
    });
    // No schema baked → descriptor stays schema-less, hash still deterministic.
    expect(contract.descriptor.methods.ping.kind).toBe('fire');
    expect(contract.descriptor.state.status.initial).toBe('idle');
    expect(typeof contract.hash).toBe('string');
  });
});
