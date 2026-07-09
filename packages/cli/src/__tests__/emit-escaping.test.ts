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

    expect(kotlinLiteralForSchema(date, dateSchema)).toBe('1709528767890L');
    expect(swiftLiteralForSchema(date, dateSchema)).toBe('1709528767890');
    expect(kotlinLiteralForSchema(bytes, binarySchema)).toBe('"AAEC/v8="');
    expect(swiftLiteralForSchema(bytes, binarySchema)).toBe('"AAEC/v8="');
  });

  it('documents that generated oneOf tag literals are byte-inert for string escaping', () => {
    const tag = 'object:a2d378a5';
    const jsonLiteral = JSON.stringify(tag);

    expect(kotlinStringLiteral(tag)).toBe(jsonLiteral);
    expect(swiftStringLiteral(tag)).toBe(jsonLiteral);
  });
});
