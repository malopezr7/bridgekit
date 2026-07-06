import type { ContractDescriptor } from '@malopezr7/bridgekit/contract';
import { memberHashes } from '@malopezr7/bridgekit/contract';
import type { RawContractToken } from '../load.js';
import { buildLock } from '../lock.js';

const descriptor: RawContractToken['descriptor'] = {
  $type: 'com.bridgekit.contract',
  descriptorVersion: 1,
  id: 'fixture.hash',
  methods: {
    translate: {
      kind: 'query',
      params: { kind: 'literals', values: ['é', '💩'] },
      result: { kind: 'string' },
    },
  },
  streams: {
    updates: {
      kind: 'stream',
      params: { kind: 'object', fields: { topic: { kind: 'string' } } },
      value: { kind: 'object', fields: { count: { kind: 'number' } } },
    },
  },
  state: {
    mood: {
      kind: 'state',
      value: { kind: 'literals', values: ['é', '💩'] },
      initial: 'é',
    },
  },
};

describe('buildLock member hashes', () => {
  it('cli_hash_member_hashes_match_core pins FNV-1a UTF-8 member hash goldens', () => {
    const lock = buildLock([{ descriptor, hash: 'contract-hash' }]);

    expect(lock.contracts['fixture.hash']?.members).toEqual({
      'methods.translate': 'f7232f5d',
      'state.mood': '1ee92d7f',
      'streams.updates': 'f2b12f34',
    });
    expect(lock.contracts['fixture.hash']?.members).toEqual(
      memberHashes(descriptor as ContractDescriptor),
    );
  });
});
