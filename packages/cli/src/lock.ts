// ---------------------------------------------------------------------------
// lock.ts — Generate and verify bridgekit.lock
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RawContractToken } from './load';

export interface LockEntry {
  hash: string;
  members: Record<string, string>;
}

export interface LockFile {
  descriptorVersion: number;
  platform?: 'kotlin' | 'swift';
  contracts: Record<string, LockEntry>;
}

// ---- member hashes (mirrors bridgekit hash.ts logic) -----------------------

function memberHashesFromDescriptor(
  descriptor: RawContractToken['descriptor'],
): Record<string, string> {
  // We need stable FNV-1a hashes per member. Since we can't import bridgekit
  // (the contract was loaded from user space), we compute them here using the
  // same algorithm as packages/core/src/contract/hash.ts.
  // The descriptor is already loaded and its .hash is computed correctly.
  // For members we replicate the logic inline.

  function sortedStringify(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return `[${(value as unknown[]).map(sortedStringify).join(',')}]`;
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const sorted = Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${sortedStringify(obj[k])}`);
      return `{${sorted.join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function fnv1a32(str: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = ((hash >>> 0) * 0x01000193) >>> 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function stableHash(val: unknown): string {
    return fnv1a32(sortedStringify(val));
  }

  const result: Record<string, string> = {};

  const methods = descriptor.methods as Record<string, unknown>;
  const streams = descriptor.streams as Record<string, unknown>;
  const state = descriptor.state as Record<string, unknown>;

  for (const [name, desc] of Object.entries(methods)) {
    result[`methods.${name}`] = stableHash(desc);
  }
  for (const [name, desc] of Object.entries(streams)) {
    result[`streams.${name}`] = stableHash(desc);
  }
  for (const [name, desc] of Object.entries(state)) {
    result[`state.${name}`] = stableHash(desc);
  }

  return result;
}

// ---- build lock from tokens ------------------------------------------------

export function buildLock(tokens: RawContractToken[], platform?: 'kotlin' | 'swift'): LockFile {
  const contracts: Record<string, LockEntry> = {};

  for (const token of tokens) {
    const id = token.descriptor.id;
    contracts[id] = {
      hash: token.hash,
      members: memberHashesFromDescriptor(token.descriptor),
    };
  }

  // Sort contract keys
  const sortedContracts: Record<string, LockEntry> = {};
  for (const key of Object.keys(contracts).sort()) {
    const entry = contracts[key];
    if (!entry) continue;
    sortedContracts[key] = {
      hash: entry.hash,
      members: Object.keys(entry.members)
        .sort()
        .reduce<Record<string, string>>((acc, k) => {
          const v = entry.members[k];
          if (v !== undefined) acc[k] = v;
          return acc;
        }, {}),
    };
  }

  const result: LockFile = {
    descriptorVersion: 1,
    contracts: sortedContracts,
  };
  if (platform) result.platform = platform;
  return result;
}

// ---- write lock file -------------------------------------------------------

export function writeLock(outDir: string, lock: LockFile): void {
  const lockPath = join(outDir, 'bridgekit.lock');
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

// ---- read existing lock ----------------------------------------------------

export function readLock(outDir: string): LockFile | null {
  const lockPath = join(outDir, 'bridgekit.lock');
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as LockFile;
  } catch {
    return null;
  }
}

// ---- diff two locks --------------------------------------------------------

export interface LockDiff {
  contract: string;
  reason: string;
}

export function diffLocks(expected: LockFile, actual: LockFile | null): LockDiff[] {
  if (!actual) {
    return [{ contract: '*', reason: 'bridgekit.lock is missing' }];
  }

  const diffs: LockDiff[] = [];

  for (const [id, expectedEntry] of Object.entries(expected.contracts)) {
    const actualEntry = actual.contracts[id];
    if (!actualEntry) {
      diffs.push({ contract: id, reason: 'missing from lock' });
      continue;
    }
    if (actualEntry.hash !== expectedEntry.hash) {
      diffs.push({
        contract: id,
        reason: `hash mismatch — expected ${expectedEntry.hash}, got ${actualEntry.hash}`,
      });
    }
  }

  // Contracts in actual but not expected
  for (const id of Object.keys(actual.contracts)) {
    if (!expected.contracts[id]) {
      diffs.push({ contract: id, reason: 'extra contract in lock not in source' });
    }
  }

  return diffs;
}
