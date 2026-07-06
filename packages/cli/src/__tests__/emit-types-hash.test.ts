import { stableHash } from '@malopezr7/bridgekit/contract';

import { hashMember } from '../emit/types.js';

describe('emit type member hashes', () => {
  it('cli_hash_member_hashes_match_core pins FNV-1a UTF-8 hashMember goldens', () => {
    const methodDescriptor = {
      kind: 'query',
      params: { kind: 'literals', values: ['é', '💩'] },
      result: { kind: 'string' },
    };
    expect(hashMember(methodDescriptor)).toBe('f7232f5d');
    expect(hashMember(methodDescriptor)).toBe(stableHash(methodDescriptor));

    expect(
      hashMember({
        kind: 'state',
        value: { kind: 'literals', values: ['é', '💩'] },
        initial: 'é',
      }),
    ).toBe('4f602849');
  });
});
