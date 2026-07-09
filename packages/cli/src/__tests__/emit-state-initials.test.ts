import { emitKotlinContract } from '../emit/kotlin.js';
import { prepareStateInitial } from '../emit/state-initial.js';
import { emitSwiftContract } from '../emit/swift.js';
import type { RawContractToken } from '../load.js';

const token: RawContractToken = {
  descriptor: {
    $type: 'com.bridgekit.contract',
    id: 'state.initial-wires',
    methods: {},
    streams: {},
    state: {
      large: { kind: 'state', value: { kind: 'int64' }, initial: 9_007_199_254_740_993n },
      updatedAt: {
        kind: 'state',
        value: { kind: 'date' },
        initial: new Date('2024-03-04T05:06:07.890Z'),
      },
      payload: {
        kind: 'state',
        value: { kind: 'binary' },
        initial: new Uint8Array([0, 1, 2, 254, 255]),
      },
      arrayBuffer: {
        kind: 'state',
        value: { kind: 'binary' },
        initial: new Uint8Array([9, 8, 7]).buffer,
      },
      negativeZero: { kind: 'state', value: { kind: 'number' }, initial: -0 },
      positiveZero: { kind: 'state', value: { kind: 'number' }, initial: 0 },
      emptyObject: { kind: 'state', value: { kind: 'object', fields: {} }, initial: {} },
      emptyRecord: {
        kind: 'state',
        value: { kind: 'record', value: { kind: 'string' } },
        initial: {},
      },
      emptyArray: {
        kind: 'state',
        value: { kind: 'array', item: { kind: 'string' } },
        initial: [],
      },
      profile: {
        kind: 'state',
        value: {
          kind: 'object',
          fields: {
            updatedAt: { kind: 'date' },
            status: {
              kind: 'union',
              discriminant: 'kind',
              variants: { active: { kind: 'object', fields: { since: { kind: 'date' } } } },
            },
            emptyObject: { kind: 'object', fields: {} },
            emptyRecord: { kind: 'record', value: { kind: 'string' } },
            emptyArray: { kind: 'array', item: { kind: 'string' } },
          },
        },
        initial: {
          updatedAt: new Date('2024-03-04T05:06:07.890Z'),
          status: { kind: 'active', since: new Date('2024-03-05T06:07:08.000Z') },
          emptyObject: {},
          emptyRecord: {},
          emptyArray: [],
        },
      },
    },
  },
  hash: '12345678',
};

describe('generated state initial wire literals', () => {
  it('returns only the encoded initial from preparation', () => {
    expect(prepareStateInitial(42, { kind: 'number' })).toEqual({ encoded: 42 });
  });

  it('emits Kotlin state initials as int64 strings, epoch milliseconds, and base64', () => {
    const source = emitKotlinContract(token, 'com.bridgekit.generated').content;

    expect(source).toContain('"large" to "9007199254740993"');
    expect(source).toContain('"updatedAt" to 1709528767890');
    expect(source).toContain('"payload" to "AAEC/v8="');
    expect(source).toContain('"arrayBuffer" to "CQgH"');
    expect(source).toContain('"negativeZero" to -0.0');
    expect(source).toContain('"positiveZero" to 0');
    expect(source).toContain('"emptyObject" to emptyMap<String, Any?>()');
    expect(source).toContain('"emptyRecord" to emptyMap<String, Any?>()');
    expect(source).toContain('"emptyArray" to emptyList<Any?>()');
    expect(source).toContain(
      '"profile" to mapOf("updatedAt" to 1709528767890, "status" to mapOf("kind" to "active", "since" to 1709618828000), "emptyObject" to emptyMap<String, Any?>(), "emptyRecord" to emptyMap<String, Any?>(), "emptyArray" to emptyList<Any?>())',
    );
  });

  it('emits Swift state initials as int64 strings, epoch milliseconds, and base64', () => {
    const source = emitSwiftContract(token, '').content;

    expect(source).toContain('"large": "9007199254740993"');
    expect(source).toContain('"updatedAt": Int64(1709528767890)');
    expect(source).toContain('"payload": "AAEC/v8="');
    expect(source).toContain('"arrayBuffer": "CQgH"');
    expect(source).toContain('"negativeZero": -0.0');
    expect(source).toContain('"positiveZero": 0');
    expect(source).toContain('"emptyObject": [:]');
    expect(source).toContain('"emptyRecord": [:]');
    expect(source).toContain('"emptyArray": []');
    expect(source).toContain(
      '"profile": ["updatedAt": Int64(1709528767890), "status": ["kind": "active", "since": Int64(1709618828000)], "emptyObject": [:], "emptyRecord": [:], "emptyArray": []]',
    );
  });
});
