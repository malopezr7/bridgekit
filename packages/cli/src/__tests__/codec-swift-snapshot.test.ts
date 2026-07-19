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

function emitRoundOneSkewContract(): string {
  const token: RawContractToken = {
    hash: 'contract-hash',
    descriptor: {
      $type: 'com.bridgekit.contract',
      id: 'fixture.round-one-skew',
      methods: {
        getString: { kind: 'query', result: { kind: 'string' } },
        getOptionalString: {
          kind: 'query',
          result: { kind: 'optional', inner: { kind: 'string' } },
        },
        getNumbers: {
          kind: 'query',
          result: { kind: 'array', item: { kind: 'number' } },
        },
        getRecord: {
          kind: 'query',
          result: { kind: 'record', value: { kind: 'string' } },
        },
        getNested: {
          kind: 'query',
          result: {
            kind: 'object',
            fields: {
              opt: {
                kind: 'array',
                item: {
                  kind: 'object',
                  fields: {
                    someKey: {
                      kind: 'object',
                      fields: { blob: { kind: 'binary' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      streams: { updates: { kind: 'stream', value: { kind: 'string' } } },
      state: {
        status: { kind: 'state', value: { kind: 'string' }, initial: 'ready' },
      },
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
  it('throws for wrong-typed required and optional plain query results', () => {
    const swift = emitRoundOneSkewContract();

    expect(swift).toContain(
      'return try ((result as? String) ?? bridgeKitThrow(path: "result", expectedType: "String", actualValue: result))',
    );
    expect(swift).toContain(
      'return result == nil ? nil : (try ((result as? String) ?? bridgeKitThrow(path: "result", expectedType: "String", actualValue: result)))',
    );
    expect(swift).not.toContain('return result as!');
    expect(swift).not.toContain('return result as?');
  });

  it('throws for wrong-typed plain collection results and identifies nested paths', () => {
    const swift = emitRoundOneSkewContract();

    expect(swift).toContain('bridgeKitThrow(path: "result", expectedType: "Array"');
    expect(swift).toContain('bridgeKitThrow(path: "result", expectedType: "Dictionary"');
    expect(swift).toContain('+ "[\\(index)]"');
    expect(swift).toContain('+ "." + entry.key');
    expect(swift).toContain('actualValue: item');
    expect(swift).toContain('actualValue: entry.value');
  });

  it('reports stream decode failures instead of swallowing them', () => {
    const swift = emitRoundOneSkewContract();

    expect(swift).toContain(
      'catch { bridgeKitReportDecodeError(error, context: "stream.updates"); cont.finish() }',
    );
    expect(swift).not.toContain('catch {}');
  });

  it('reports state decode failures before applying the typed fallback', () => {
    const swift = emitRoundOneSkewContract();

    expect(swift).toContain(
      'catch { bridgeKitReportDecodeError(error, context: "state.status"); return nil }',
    );
    expect(swift).not.toContain('in try? (');
  });

  it('emits throwing skew-safe boundary decoders without process-aborting casts', () => {
    const swift = emitSkewSafetyContract();

    expect(swift).not.toContain('fatalError');
    expect(swift).not.toContain('as!');
    expect(swift).toContain(
      'throw BridgeKitDecodeError(path: "result", expectedType: "GetLiteralResult", actualValue: result)',
    );
    expect(swift).toContain(
      'bridgeKitThrow(path: "result", expectedType: "GetObjectResult", actualValue: result)',
    );
    expect(swift).toContain(
      'bridgeKitThrow(path: "result", expectedType: "GetUnionResult", actualValue: result)',
    );
    expect(swift).toContain(
      'bridgeKitThrow(path: "result", expectedType: "GetTupleResult", actualValue: result)',
    );
  });

  it('cli_codec_snapshots_emit_int64_string_kotlin_swift emits decimal string int64 boundaries', () => {
    const swift = emitInt64Contract();

    expect(swift).toContain(
      'case "getCounter":\n            return String(try await impl.getCounter())',
    );
    expect(swift).toContain(
      'return try Int64((result as? String) ?? bridgeKitThrow(path: "result", expectedType: "Int64", actualValue: result)) ?? bridgeKitThrow(path: "result", expectedType: "Int64", actualValue: result)',
    );
    expect(swift).toContain('map["count"] = String(value.count)');
    expect(swift).toContain(
      'count: try Int64((raw["count"] as Any? as? String) ?? bridgeKitThrow(path: path.isEmpty ? "count" : path + ".count", expectedType: "Int64", actualValue: raw["count"] as Any?)) ?? bridgeKitThrow(path: path.isEmpty ? "count" : path + ".count", expectedType: "Int64", actualValue: raw["count"] as Any?)',
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
      'guard let tag = raw["@t"] as? String else { throw BridgeKitDecodeError(path: path.isEmpty ? "@t" : path + ".@t", expectedType: "ChooseResult", actualValue: raw["@t"] as Any?) }',
    );
    expect(swift).toContain('let v = raw["@v"] as Any?');
    expect(swift).toContain('switch tag {');
    expect(swift).toContain(
      'default: throw BridgeKitDecodeError(path: path.isEmpty ? "@t" : path + ".@t", expectedType: "ChooseResult", actualValue: tag)',
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
