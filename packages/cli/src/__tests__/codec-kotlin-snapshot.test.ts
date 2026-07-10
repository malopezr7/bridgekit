import { t } from '@malopezr7/bridgekit/contract';
import { emitKotlinContract } from '../emit/kotlin.js';
import type { RawContractToken } from '../load.js';

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

  return emitKotlinContract(token, 'com.bridgekit.fixtures').content;
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

  return emitKotlinContract(token, 'com.bridgekit.fixtures').content;
}

function emitRecordContract(): string {
  const token: RawContractToken = {
    hash: 'contract-hash',
    descriptor: {
      $type: 'com.bridgekit.contract',
      id: 'fixture.record',
      methods: {
        getRecord: {
          kind: 'query',
          result: t.object({ values: t.record(t.string()) }),
        },
      },
      streams: {},
      state: {},
    },
  };

  return emitKotlinContract(token, 'com.bridgekit.fixtures').content;
}

function coreOneOfTags(oneOfSchema: ReturnType<typeof t.oneOf>): readonly string[] {
  return (oneOfSchema as unknown as { tags: readonly string[] }).tags;
}

describe('Kotlin codec snapshots', () => {
  it('keeps decoded record values non-null inside associate pairs', () => {
    const kotlin = emitRecordContract();

    expect(kotlin).toContain(
      'k.toString() to ((v as? String) ?: throw BridgeKitDecodeException("values", "String"))',
    );
  });

  it('cli_codec_snapshots_emit_int64_string_kotlin_swift emits decimal string int64 boundaries', () => {
    const kotlin = emitInt64Contract();

    expect(kotlin).toContain(
      '"getCounter" -> {\n                    impl.getCounter().toString()\n                }',
    );
    expect(kotlin).toContain(
      'return when (val v = result) { is String -> v.toLong(); else -> throw BridgeKitDecodeException("result", "Long") }',
    );
    expect(kotlin).toContain('map["count"] = value.count.toString()');
    expect(kotlin).toContain(
      'count = when (val v = raw["count"]) { is String -> v.toLong(); else -> throw BridgeKitDecodeException("count", "Long") },',
    );
  });

  it('cli_codec_snapshots_emit_oneof_t_tags_kotlin_swift bakes core-derived @t tag literals', () => {
    const stringOption = t.string();
    const objectOption = t.object({ id: t.string(), count: t.number() });
    const oneOfSchema = t.oneOf([stringOption, objectOption]);
    const [stringTag, objectTag] = coreOneOfTags(oneOfSchema);

    const kotlin = emitOneOfContract(oneOfSchema);

    expect(kotlin).toContain(
      `is ChooseResult.Opt0 -> mapOf("@t" to "${stringTag}", "@v" to value.value)`,
    );
    expect(kotlin).toContain(
      `is ChooseResult.Opt1 -> mapOf("@t" to "${objectTag}", "@v" to FixtureCodecCodecs.encodeChooseResultOpt1(value.value))`,
    );
    expect(kotlin).toContain(
      'val tag = raw["@t"] as? String ?: throw BridgeKitDecodeException("@t", "ChooseResult")',
    );
    expect(kotlin).toContain(`"${stringTag}" -> ChooseResult.Opt0(`);
    expect(kotlin).toContain(`"${objectTag}" -> ChooseResult.Opt1(`);
    expect(kotlin).toContain('else -> throw BridgeKitDecodeException("@t=$tag", "ChooseResult")');
    expect(kotlin).toContain('val v = raw["@v"]');
    expect(kotlin).not.toContain('"@k"');
  });

  it('keeps the baked Kotlin oneOf tag for the same option stable when options are reordered', () => {
    const stringOption = t.string();
    const objectOption = t.object({ id: t.string(), count: t.number() });
    const original = t.oneOf([stringOption, objectOption]);
    const reordered = t.oneOf([objectOption, stringOption]);
    const objectTagFromCore = coreOneOfTags(t.oneOf([objectOption]))[0];

    const originalKotlin = emitOneOfContract(original);
    const reorderedKotlin = emitOneOfContract(reordered);

    expect(coreOneOfTags(original)[1]).toBe(objectTagFromCore);
    expect(coreOneOfTags(reordered)[0]).toBe(objectTagFromCore);
    expect(originalKotlin).toContain(`"@t" to "${objectTagFromCore}"`);
    expect(reorderedKotlin).toContain(`"@t" to "${objectTagFromCore}"`);
  });
});
