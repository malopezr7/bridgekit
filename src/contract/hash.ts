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

function fnv1a32(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // Unsigned 32-bit multiply: split into 16-bit halves to avoid overflow
    hash = ((hash >>> 0) * 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute a stable FNV-1a 32-bit hex hash over any serializable value.
 * Object keys are sorted recursively, so key insertion order does not affect the hash.
 */
export function stableHash(value: unknown): string {
  return fnv1a32(sortedStringify(value));
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
