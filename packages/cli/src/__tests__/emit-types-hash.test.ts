import { stableHash } from '@malopezr7/bridgekit/contract';

import type { ObjectNode } from '../emit/types.js';
import { hashMember, KotlinTypeEmitter } from '../emit/types.js';

describe('emit type member hashes', () => {
  it('cli_hash_member_hashes_match_core pins FNV-1a UTF-8 hashMember goldens', () => {
    const methodDescriptor = {
      kind: 'query',
      params: { kind: 'literals', values: ['é', '💩'] },
      result: { kind: 'string' },
    };
    expect(hashMember(methodDescriptor)).toBe('f7232f5d');
    expect(hashMember(methodDescriptor)).toBe(stableHash(methodDescriptor));

    const oneOfMethodDescriptor = {
      kind: 'query',
      params: {
        kind: 'oneOf',
        options: [
          { kind: 'object', fields: { id: { kind: 'string' }, count: { kind: 'number' } } },
          { kind: 'string' },
        ],
      },
      result: { kind: 'string' },
    };
    expect(hashMember(oneOfMethodDescriptor)).toBe('1670b71c');
    expect(hashMember(oneOfMethodDescriptor)).toBe(stableHash(oneOfMethodDescriptor));

    expect(
      hashMember({
        kind: 'state',
        value: { kind: 'literals', values: ['é', '💩'] },
        initial: 'é',
      }),
    ).toBe('4f602849');
  });

  it('cli_allocate_name_suffixes_structurally_different_schema_types_with_same_candidate_name', () => {
    const emitter = new KotlinTypeEmitter('Fixture');
    const stringPayloadNode: ObjectNode = {
      kind: 'object',
      fields: { value: { kind: 'string' } },
    };
    const numberPayloadNode: ObjectNode = {
      kind: 'object',
      fields: { value: { kind: 'number' } },
    };

    const stringPayload = emitter.emit(stringPayloadNode, 'payload');
    const numberPayload = emitter.emit(numberPayloadNode, 'payload');

    expect(numberPayload.typeName).not.toBe(stringPayload.typeName);
    expect(numberPayload.typeName).toMatch(/^Payload_[0-9a-f]{4}$/);
    expect(emitter.getDeclarations()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('data class Payload('),
        expect.stringContaining(`data class ${numberPayload.typeName}(`),
      ]),
    );
  });
});
