import { encode, t } from '@malopezr7/bridgekit/contract';
import { emitSwiftContract } from '../emit/swift.js';
import type { RawContractToken } from '../load.js';

type OneOfWire = { '@t': string; '@v': unknown };

function emitOneOfContract(oneOfSchema: ReturnType<typeof t.oneOf>): string {
  const token: RawContractToken = {
    hash: 'contract-hash',
    descriptor: {
      $type: 'com.bridgekit.contract',
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

function emitInt64Contract(): string {
  const token: RawContractToken = {
    hash: 'contract-hash',
    descriptor: {
      $type: 'com.bridgekit.contract',
      id: 'fixture.int64',
      methods: {
        getCounter: {
          kind: 'query',
          result: t.int64(),
        },
        getBox: {
          kind: 'query',
          result: t.object({ count: t.int64() }),
        },
      },
      streams: {},
      state: {},
    },
  };

  return emitSwiftContract(token, 'BridgeKitFixtures').content;
}

function emitSkewSafetyContract(): string {
  const token: RawContractToken = {
    hash: 'contract-hash',
    descriptor: {
      $type: 'com.bridgekit.contract',
      id: 'fixture.skew-safety',
      methods: {
        getLiteral: {
          kind: 'query',
          result: { kind: 'literals', values: ['ready', 'done'] },
        },
        getObject: {
          kind: 'query',
          result: { kind: 'object', fields: { value: { kind: 'string' } } },
        },
        getUnion: {
          kind: 'query',
          result: {
            kind: 'union',
            discriminant: 'kind',
            variants: {
              success: { kind: 'object', fields: { value: { kind: 'string' } } },
              failure: { kind: 'object', fields: { reason: { kind: 'string' } } },
            },
          },
        },
        getTuple: {
          kind: 'query',
          result: { kind: 'tuple', items: [{ kind: 'string' }, { kind: 'number' }] },
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
  it('emits throwing skew-safe boundary decoders without process-aborting casts', () => {
    const swift = emitSkewSafetyContract();

    expect(swift).not.toContain('fatalError');
    expect(swift).not.toContain('as!');
    expect(swift).toContain(
      'throw BridgeKitDecodeError(field: "result", expectedType: "GetLiteralResult")',
    );
    expect(swift).toContain('bridgeKitThrow(field: "result", expectedType: "GetObjectResult")');
    expect(swift).toContain('bridgeKitThrow(field: "result", expectedType: "GetUnionResult")');
    expect(swift).toContain('bridgeKitThrow(field: "result", expectedType: "GetTupleResult")');
  });

  it('cli_codec_snapshots_emit_int64_string_kotlin_swift emits decimal string int64 boundaries', () => {
    const swift = emitInt64Contract();

    expect(swift).toContain(
      'case "getCounter":\n            return String(try await impl.getCounter())',
    );
    expect(swift).toContain(
      'return try Int64((result as? String) ?? bridgeKitThrow(field: "result", expectedType: "Int64")) ?? bridgeKitThrow(field: "result", expectedType: "Int64")',
    );
    expect(swift).toContain('map["count"] = String(value.count)');
    expect(swift).toContain(
      'count: try Int64((raw["count"] as Any? as? String) ?? bridgeKitThrow(field: "count", expectedType: "Int64")) ?? bridgeKitThrow(field: "count", expectedType: "Int64")',
    );
  });

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
