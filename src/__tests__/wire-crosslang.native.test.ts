/**
 * WU-1 RED — cross-language wire safety net (B0).
 *
 * These tests simulate the actual Kotlin→JS wire path:
 *   - Kotlin epoch Long → Nitro bigint → JS codec → Date
 *   - Kotlin base64 ByteArray → Nitro String → JS codec → Uint8Array (no Buffer)
 *
 * They MUST fail on HEAD (C-1 and D6 not yet fixed).
 *
 * Runs under the "native" jest project (babel-jest RN preset, Node env).
 */
import { describe, expect, test } from '@jest/globals';
import { decode, encode } from '../contract/codec';
import type { Schema } from '../contract/schema';
import { t } from '../contract/schema';

// ---- helpers ----------------------------------------------------------------

/** A date schema node as the runtime schema object. */
const dateSchema: Schema = t.date();
/** A binary schema node. */
const binarySchema: Schema = t.binary();

// ---- C-1: bigint-aware Date decode ------------------------------------------

describe('C-1: bigint-aware Date decode (cross-language wire)', () => {
  test('bigint epoch inbound — Kotlin Long→bigint → must produce Date, not TypeError', () => {
    const epochMs = 1_700_000_000_000n; // bigint — as Nitro delivers Long from Kotlin
    // On unfixed HEAD: new Date(bigint) throws TypeError
    // Expected: a valid Date with the correct ms value
    const result = decode(dateSchema, epochMs);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).getTime()).toBe(Number(epochMs));
  });

  test('number backward compat — non-bigint epoch must still produce valid Date', () => {
    const epochMs = 1_700_000_000_000; // number — older wire path / JS self-invoke
    const result = decode(dateSchema, epochMs);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).getTime()).toBe(epochMs);
  });

  test('round-trip identity (ms precision) — encode then decode same Date', () => {
    const original = new Date(1_700_000_000_123);
    const encoded = encode(dateSchema, original);
    // encoded should be a number (epoch ms) for the wire
    expect(typeof encoded).toBe('number');
    const decoded = decode(dateSchema, encoded as number);
    expect(decoded).toBeInstanceOf(Date);
    expect((decoded as Date).getTime()).toBe(original.getTime());
  });

  test('bigint round-trip — bigint in, Date out, consistent with number path', () => {
    const epochMs = 1_700_000_000_456n;
    const decoded = decode(dateSchema, epochMs);
    expect(decoded).toBeInstanceOf(Date);
    expect((decoded as Date).getTime()).toBe(Number(epochMs));
  });
});

// ---- D6: binary portability — no Buffer global ------------------------------

describe('D6: binary/Buffer portability (Hermes — no Buffer global)', () => {
  test('decode base64 string → Uint8Array without relying on Buffer', () => {
    // Shadow the Buffer global to simulate Hermes/JSC environment
    const originalBuffer = (globalThis as Record<string, unknown>).Buffer;
    (globalThis as Record<string, unknown>).Buffer = undefined;

    try {
      const base64 = 'SGVsbG8gV29ybGQ='; // "Hello World"
      const result = decode(binarySchema, base64);
      expect(result).toBeInstanceOf(Uint8Array);
      const expected = new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]);
      expect(result as Uint8Array).toEqual(expected);
    } finally {
      (globalThis as Record<string, unknown>).Buffer = originalBuffer;
    }
  });

  test('encode Uint8Array → base64 string without relying on Buffer', () => {
    const originalBuffer = (globalThis as Record<string, unknown>).Buffer;
    (globalThis as Record<string, unknown>).Buffer = undefined;

    try {
      const bytes = new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]);
      const result = encode(binarySchema, bytes);
      expect(typeof result).toBe('string');
      expect(result).toBe('SGVsbG8gV29ybGQ=');
    } finally {
      (globalThis as Record<string, unknown>).Buffer = originalBuffer;
    }
  });

  test('encode+decode round-trip byte-identical without Buffer', () => {
    const originalBuffer = (globalThis as Record<string, unknown>).Buffer;
    (globalThis as Record<string, unknown>).Buffer = undefined;

    try {
      const original = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
      const encoded = encode(binarySchema, original);
      const decoded = decode(binarySchema, encoded as string);
      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(decoded as Uint8Array).toEqual(original);
    } finally {
      (globalThis as Record<string, unknown>).Buffer = originalBuffer;
    }
  });
});
