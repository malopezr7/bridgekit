import { emitKotlinContract } from '../emit/kotlin.js';
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
    },
  },
  hash: '12345678',
};

describe('generated state initial wire literals', () => {
  it('emits Kotlin state initials as int64 strings, epoch milliseconds, and base64', () => {
    const source = emitKotlinContract(token, 'com.bridgekit.generated').content;

    expect(source).toContain('"large" to "9007199254740993"');
    expect(source).toContain('"updatedAt" to 1709528767890L');
    expect(source).toContain('"payload" to "AAEC/v8="');
  });

  it('emits Swift state initials as int64 strings, epoch milliseconds, and base64', () => {
    const source = emitSwiftContract(token, '').content;

    expect(source).toContain('"large": "9007199254740993"');
    expect(source).toContain('"updatedAt": 1709528767890');
    expect(source).toContain('"payload": "AAEC/v8="');
  });
});
