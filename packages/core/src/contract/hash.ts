// ---------------------------------------------------------------------------
// Stable hash — FNV-1a 32-bit, no node:crypto (must run in RN/Hermes)
// Recursively sorts object keys before stringifying for determinism.
// ---------------------------------------------------------------------------

import type { ContractDescriptor } from './contract';

// ---- stable stringify -----------------------------------------------------

function sortedStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return `[${value.map(sortedStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedStringify(obj[k])}`);
    return `{${sorted.join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---- FNV-1a 32-bit --------------------------------------------------------

function utf8Bytes(str: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);

  const bytes: number[] = [];
  for (const char of str) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export function hash8hex(str: string): string {
  let hash = 0x811c9dc5;
  for (const byte of utf8Bytes(str)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Compute a stable FNV-1a 32-bit hex hash over any serializable value.
 * Object keys are sorted recursively, so key insertion order does not affect the hash.
 */
export function stableHash(value: unknown): string {
  return hash8hex(sortedStringify(value));
}

/**
 * Compute per-member hashes for skew diffing.
 * Keys use the path prefix: "methods.x", "streams.y", "state.z".
 */
export function memberHashes(descriptor: ContractDescriptor): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, desc] of Object.entries(descriptor.methods)) {
    result[`methods.${name}`] = stableHash(desc);
  }
  for (const [name, desc] of Object.entries(descriptor.streams)) {
    result[`streams.${name}`] = stableHash(desc);
  }
  for (const [name, desc] of Object.entries(descriptor.state)) {
    result[`state.${name}`] = stableHash(desc);
  }

  return result;
}
