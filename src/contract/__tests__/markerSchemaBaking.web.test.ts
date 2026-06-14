// Wave 1 keystone: marker descriptors carry resolved AnySchema (design Decision 1).
//
// These tests assert that defineContract(id, shape, generatedSchemas) bakes the
// resolved schemas into each descriptor member, and that the resulting runtime
// contractHash is byte-for-byte equal to the hash the CLI computes over the SAME
// descriptor structure (hash parity by construction).
//
// ADR-7 (W4): demo contract dogfood — demo contracts must pass generatedSchemas as
// the 3rd arg so the in-app runtime hash matches the generated Kotlin Contract hash.

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

// ---------------------------------------------------------------------------
// ADR-7 — dogfood generated schemas in demo contracts (W4 hash-parity proof)
//
// The bridgekit.demo-host contract is the keystone dogfood target.
// The generated hash (from bridgekit.demo-host.bridge.ts) is 7eae3360.
// These tests prove:
//   1. Without the 3rd arg → runtime hash differs from 7eae3360 (the defect).
//   2. With the 3rd arg (generatedSchemas) → runtime hash === 7eae3360 (the fix).
//
// W1 fix: imports the REAL co-located .bridge.ts (not an inline constant) so any
// schema drift causes this test to pick up the updated schemas automatically.
// ---------------------------------------------------------------------------

// Import the ACTUAL generated schema artifact — same file the demo contract imports.
// If the CLI regenerates and the schema changes, this test picks it up automatically.
import { generatedSchemas as demoHostGeneratedSchemas } from '../../../../../features/simple-feature/src/bridgekit-demo/contracts/bridgekit.demo-host.bridge';

const DEMO_HOST_GENERATED_HASH = '7eae3360';

/** Shape matching features/simple-feature/src/bridgekit-demo/contracts/demo-host.contract.ts */
function makeDemoHostShape() {
  return {
    methods: {
      ping: Async<{ message: string }, { reply: string; epoch: number }>(),
      increment: Async<number>(),
      say: Void<{ text: string }>(),
    },
    streams: {
      ticker: Stream<number>(),
      echoes: Stream<string>(),
    },
    state: {
      counter: State<number>(0),
    },
  };
}

describe('ADR-7 — demo-host hash parity (dogfood schema proof)', () => {
  it('without 3rd arg the runtime hash differs from the generated CLI hash (proves the defect)', () => {
    const contractNoSchema = defineContract('bridgekit.demo-host', makeDemoHostShape());
    // This is the pre-fix state: no schema baked → hash does not match the generated one.
    expect(contractNoSchema.hash).not.toBe(DEMO_HOST_GENERATED_HASH);
  });

  it('with generatedSchemas the runtime hash equals the generated CLI hash (proves the fix)', () => {
    const contractWithSchema = defineContract(
      'bridgekit.demo-host',
      makeDemoHostShape(),
      demoHostGeneratedSchemas,
    );
    // Hash parity: the in-app runtime hash must equal the Kotlin Contract hash 7eae3360.
    expect(contractWithSchema.hash).toBe(DEMO_HOST_GENERATED_HASH);
  });

  it('generatedSchemas bakes method schemas into the demo-host descriptor', () => {
    const contract = defineContract(
      'bridgekit.demo-host',
      makeDemoHostShape(),
      demoHostGeneratedSchemas,
    );
    expect(contract.descriptor.methods.ping.params).toEqual({
      fields: { message: { kind: 'string' } },
      kind: 'object',
    });
    expect(contract.descriptor.streams.ticker.value).toEqual({ kind: 'number' });
    expect(contract.descriptor.state.counter.value).toEqual({ kind: 'number' });
  });
});

// ---------------------------------------------------------------------------
// W1(b) — Schema copy parity: feature co-located .bridge.ts files must stay
// byte-identical to the platforms/android generated copies.
//
// When `bridgekit generate` runs, it writes to platforms/android/.../generated/.
// The co-located copies in features/.../contracts/ are updated manually or via
// a re-run with --into. This test fails if the two sets drift apart, giving CI
// a hard enforcement gate to catch stale manual copies.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../../../');
const FEATURE_CONTRACTS = `${REPO_ROOT}/features/simple-feature/src/bridgekit-demo/contracts`;
const ANDROID_GENERATED = `${REPO_ROOT}/platforms/android/app/src/main/java/com/example/demo/bridgekit/generated`;

const SCHEMA_FILES = [
  'bridgekit.demo-host.bridge.ts',
  'bridgekit.demo-reverse.bridge.ts',
  'bridgekit.demo-jsinfo.bridge.ts',
  'bridgekit.demo-feature.bridge.ts',
  'bridgekit.localhost.bridge.ts',
];

describe('W1(b) — dogfood .bridge.ts copy parity (CI drift gate)', () => {
  for (const fileName of SCHEMA_FILES) {
    it(`${fileName}: feature copy is byte-identical to android generated copy`, () => {
      const featurePath = `${FEATURE_CONTRACTS}/${fileName}`;
      const androidPath = `${ANDROID_GENERATED}/${fileName}`;
      const featureContent = readFileSync(featurePath, 'utf8');
      const androidContent = readFileSync(androidPath, 'utf8');
      expect(featureContent).toBe(androidContent);
    });
  }
});
