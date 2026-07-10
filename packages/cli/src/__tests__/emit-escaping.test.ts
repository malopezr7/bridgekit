import {
  escapeSwiftIdentifier,
  swiftLiteralForSchema,
  swiftStringLiteral,
} from '../emit/swift-types.js';
import {
  escapeKotlinIdentifier,
  kotlinLiteralForSchema,
  kotlinStringLiteral,
  type SchemaNode,
} from '../emit/types.js';

describe('emit escaping helpers', () => {
  it('escapes Kotlin string-template markers while preserving ordinary string literals', () => {
    expect(kotlinStringLiteral('price: $total')).toBe('"price: \\$total"');
    expect(kotlinStringLiteral('plain')).toBe('"plain"');
  });

  it('emits Swift control characters with Swift unicode escape syntax', () => {
    expect(swiftStringLiteral('prefix\u0001suffix')).toBe('"prefix\\u{1}suffix"');
    expect(swiftStringLiteral('prefix\u0001suffix')).not.toBe(JSON.stringify('prefix\u0001suffix'));
  });

  it('escapes Kotlin keywords as identifiers without touching ordinary identifiers', () => {
    expect(escapeKotlinIdentifier('object')).toBe('`object`');
    expect(escapeKotlinIdentifier('fun')).toBe('`fun`');
    expect(escapeKotlinIdentifier('is')).toBe('`is`');
    expect(escapeKotlinIdentifier('ordinaryName')).toBe('ordinaryName');
  });

  it('escapes Swift keywords as identifiers without touching ordinary identifiers', () => {
    expect(escapeSwiftIdentifier('class')).toBe('`class`');
    expect(escapeSwiftIdentifier('ordinaryName')).toBe('ordinaryName');
  });

  it('emits int64 state initials as decimal wire strings on both platforms', () => {
    const int64Schema: SchemaNode = { kind: 'int64' };
    const numberSchema: SchemaNode = { kind: 'number' };

    expect(kotlinLiteralForSchema(9_007_199_254_740_993n, int64Schema)).toBe('"9007199254740993"');
    expect(swiftLiteralForSchema(9_007_199_254_740_993n, int64Schema)).toBe('"9007199254740993"');
    expect(kotlinLiteralForSchema(42, numberSchema)).toBe('42');
    expect(swiftLiteralForSchema(42, numberSchema)).toBe('42');
  });

  it('emits date and binary state initials in their wire formats on both platforms', () => {
    const dateSchema: SchemaNode = { kind: 'date' };
    const binarySchema: SchemaNode = { kind: 'binary' };
    const date = new Date('2024-03-04T05:06:07.890Z');
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);

    expect(kotlinLiteralForSchema(date, dateSchema)).toBe('1709528767890');
    expect(swiftLiteralForSchema(date, dateSchema)).toBe('Int64(1709528767890)');
    expect(kotlinLiteralForSchema(bytes, binarySchema)).toBe('"AAEC/v8="');
    expect(swiftLiteralForSchema(bytes, binarySchema)).toBe('"AAEC/v8="');
    expect(kotlinLiteralForSchema(bytes.buffer, binarySchema)).toBe('"AAEC/v8="');
    expect(swiftLiteralForSchema(bytes.buffer, binarySchema)).toBe('"AAEC/v8="');
  });

  it('emits shape-aware empty collections at top level and nested positions', () => {
    const schema: SchemaNode = {
      kind: 'object',
      fields: {
        object: { kind: 'object', fields: {} },
        record: { kind: 'record', value: { kind: 'string' } },
        array: { kind: 'array', item: { kind: 'string' } },
      },
    } as SchemaNode;
    const value = { object: {}, record: {}, array: [] };

    expect(kotlinLiteralForSchema({}, { kind: 'object', fields: {} } as SchemaNode)).toBe(
      'emptyMap<String, Any?>()',
    );
    expect(
      kotlinLiteralForSchema({}, { kind: 'record', value: { kind: 'string' } } as SchemaNode),
    ).toBe('emptyMap<String, Any?>()');
    expect(
      kotlinLiteralForSchema([], { kind: 'array', item: { kind: 'string' } } as SchemaNode),
    ).toBe('emptyList<Any?>()');
    expect(kotlinLiteralForSchema(value, schema)).toBe(
      'mapOf("object" to emptyMap<String, Any?>(), "record" to emptyMap<String, Any?>(), "array" to emptyList<Any?>())',
    );

    expect(swiftLiteralForSchema({}, { kind: 'object', fields: {} } as SchemaNode)).toBe('[:]');
    expect(
      swiftLiteralForSchema({}, { kind: 'record', value: { kind: 'string' } } as SchemaNode),
    ).toBe('[:]');
    expect(
      swiftLiteralForSchema([], { kind: 'array', item: { kind: 'string' } } as SchemaNode),
    ).toBe('[]');
    expect(swiftLiteralForSchema(value, schema)).toBe(
      '["object": [:], "record": [:], "array": []]',
    );
  });

  it('preserves negative zero literals separately from positive zero', () => {
    const schema: SchemaNode = { kind: 'number' };

    expect(kotlinLiteralForSchema(-0, schema)).toBe('-0.0');
    expect(kotlinLiteralForSchema(0, schema)).toBe('0');
    expect(swiftLiteralForSchema(-0, schema)).toBe('-0.0');
    expect(swiftLiteralForSchema(0, schema)).toBe('0');
  });

  it.each([
    ['Date', new Date(0)],
    ['Uint8Array', new Uint8Array([1])],
    ['ArrayBuffer', new Uint8Array([1]).buffer],
    ['BigInt', 1n],
  ])('rejects non-JSON %s values inside t.json with their path', (_label, special) => {
    const schema = {
      kind: 'object',
      fields: { metadata: { kind: 'json' } },
    } as SchemaNode;

    expect(() => kotlinLiteralForSchema({ metadata: { nested: special } }, schema)).toThrow(
      /state initial.*metadata\.nested.*not JSON-compatible/i,
    );
    expect(() => swiftLiteralForSchema({ metadata: { nested: special } }, schema)).toThrow(
      /state initial.*metadata\.nested.*not JSON-compatible/i,
    );
  });

  it('rejects unknown nested schema kinds before core encoding', () => {
    const schema = {
      kind: 'object',
      fields: { future: { kind: 'future-kind' } },
    } as SchemaNode;

    expect(() => kotlinLiteralForSchema({ future: 'value' }, schema)).toThrow(
      /unsupported schema kind 'future-kind'.*\.future/i,
    );
    expect(() => swiftLiteralForSchema({ future: 'value' }, schema)).toThrow(
      /unsupported schema kind 'future-kind'.*\.future/i,
    );
  });

  it('documents that generated oneOf tag literals are byte-inert for string escaping', () => {
    const tag = 'object:a2d378a5';
    const jsonLiteral = JSON.stringify(tag);

    expect(kotlinStringLiteral(tag)).toBe(jsonLiteral);
    expect(swiftStringLiteral(tag)).toBe(jsonLiteral);
  });
});
