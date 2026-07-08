import { encode, t } from '@malopezr7/bridgekit/contract';
import { emitSwiftContract } from '../emit/swift.js';
import type { RawContractToken } from '../load.js';

type OneOfWire = { '@t': string; '@v': unknown };

function emitOneOfContract(oneOfSchema: ReturnType<typeof t.oneOf>): string {
  const token: RawContractToken = {
    hash: 'contract-hash',
    descriptor: {
      $type: 'com.bridgekit.contract',
      descriptorVersion: 1,
      id: 'fixture.codec',
      methods: {
        choose: {
          kind: 'query',
          params: { kind: 'object', fields: { input: oneOfSchema } },
          result: oneOfSchema,
        },
      },
      streams: {},
      state: {},
    },
  };

  return emitSwiftContract(token, 'BridgeKitFixtures').content;
}

function coreOneOfTags(oneOfSchema: ReturnType<typeof t.oneOf>): readonly string[] {
  return (oneOfSchema as unknown as { tags: readonly string[] }).tags;
}

function jsRuntimeTag(oneOfSchema: ReturnType<typeof t.oneOf>, value: unknown): string {
  return (encode(oneOfSchema, value) as OneOfWire)['@t'];
}

describe('Swift codec snapshots', () => {
  it('cli_codec_snapshots_emit_oneof_t_tags_kotlin_swift bakes JS-runtime-equivalent @t tag literals', () => {
    const stringOption = t.string();
    const numberOption = t.number();
    const objectOption = t.object({ id: t.string(), count: t.number() });
    const nestedOption = t.object({ nested: t.oneOf([t.string(), t.number()] as const) });
    const oneOfSchema = t.oneOf([stringOption, numberOption, objectOption, nestedOption] as const);

    const values = ['hello', 42, { id: 'obj', count: 7 }, { nested: 'child' }] as const;
    const tags = coreOneOfTags(oneOfSchema);
    const swift = emitOneOfContract(oneOfSchema);

    for (let i = 0; i < values.length; i++) {
      expect(tags[i]).toBe(jsRuntimeTag(oneOfSchema, values[i]));
      expect(swift).toContain(`case .opt${i}(let v): return ["@t": "${tags[i]}", "@v": `);
      expect(swift).toContain(`case "${tags[i]}": return .opt${i}(`);
    }

    expect(swift).toContain(
      'guard let tag = raw["@t"] as? String else { throw BridgeKitDecodeError(field: "@t", expectedType: "ChooseResult") }',
    );
    expect(swift).toContain('let v = raw["@v"] as Any?');
    expect(swift).toContain('switch tag {');
    expect(swift).toContain(
      'default: throw BridgeKitDecodeError(field: "@t=\\(tag)", expectedType: "ChooseResult")',
    );
    expect(swift).not.toContain('"@k"');
    expect(swift).not.toContain('switch k {');
  });

  it('keeps the baked Swift oneOf tag for the same option stable when options are reordered', () => {
    const stringOption = t.string();
    const objectOption = t.object({ id: t.string(), count: t.number() });
    const original = t.oneOf([stringOption, objectOption] as const);
    const reordered = t.oneOf([objectOption, stringOption] as const);
    const objectTagFromCore = coreOneOfTags(t.oneOf([objectOption] as const))[0];

    const originalSwift = emitOneOfContract(original);
    const reorderedSwift = emitOneOfContract(reordered);

    expect(coreOneOfTags(original)[1]).toBe(objectTagFromCore);
    expect(coreOneOfTags(reordered)[0]).toBe(objectTagFromCore);
    expect(originalSwift).toContain(`"@t": "${objectTagFromCore}"`);
    expect(reorderedSwift).toContain(`"@t": "${objectTagFromCore}"`);
  });
});
