// ---------------------------------------------------------------------------
// lock.ts — Generate and verify bridgekit.lock
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractDescriptor } from '@malopezr7/bridgekit/contract';
import { memberHashes } from '@malopezr7/bridgekit/contract';

import type { RawContractToken } from './load.js';

export interface LockEntry {
  hash: string;
  members: Record<string, string>;
}

export interface LockFile {
  descriptorVersion: number;
  platform?: 'kotlin' | 'swift';
  contracts: Record<string, LockEntry>;
}

// ---- build lock from tokens ------------------------------------------------

export function buildLock(tokens: RawContractToken[], platform?: 'kotlin' | 'swift'): LockFile {
  const contracts: Record<string, LockEntry> = {};

  for (const token of tokens) {
    const id = token.descriptor.id;
    contracts[id] = {
      hash: token.hash,
      members: memberHashes(token.descriptor as ContractDescriptor),
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
