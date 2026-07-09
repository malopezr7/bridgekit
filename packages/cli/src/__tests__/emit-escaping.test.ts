import { escapeSwiftIdentifier, swiftStringLiteral } from '../emit/swift-types.js';
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

  it('suffixes Kotlin int64 literals with L only for int64 schema values', () => {
    const int64Schema: SchemaNode = { kind: 'int64' };
    const numberSchema: SchemaNode = { kind: 'number' };

    expect(kotlinLiteralForSchema(2147483648n, int64Schema)).toBe('2147483648L');
    expect(kotlinLiteralForSchema(42, int64Schema)).toBe('42L');
    expect(kotlinLiteralForSchema(42, numberSchema)).toBe('42');
  });

  it('documents that generated oneOf tag literals are byte-inert for string escaping', () => {
    const tag = 'object:a2d378a5';
    const jsonLiteral = JSON.stringify(tag);

    expect(kotlinStringLiteral(tag)).toBe(jsonLiteral);
    expect(swiftStringLiteral(tag)).toBe(jsonLiteral);
  });
});
