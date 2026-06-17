// ---------------------------------------------------------------------------
// check.ts — --check mode: compare generated output against existing out-dir
// ---------------------------------------------------------------------------

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { EmitResult } from './emit/kotlin';
import { diffLocks, type LockFile } from './lock';

export interface CheckDiff {
  file: string;
  reason: string;
}

/**
 * Compare freshly generated output against the existing out-dir.
 * Returns list of diffs (empty = no drift).
 */
export function checkDrift(
  emitResults: EmitResult[],
  newLock: LockFile,
  outDir: string,
): CheckDiff[] {
  const diffs: CheckDiff[] = [];

  // Check Kotlin files
  for (const result of emitResults) {
    const existingPath = path.join(outDir, result.fileName);
    if (!existsSync(existingPath)) {
      diffs.push({ file: result.fileName, reason: 'file missing from out-dir' });
      continue;
    }
    const existing = readFileSync(existingPath, 'utf8');
    if (normalizeContent(existing) !== normalizeContent(result.content)) {
      diffs.push({ file: result.fileName, reason: 'content differs' });
    }
  }

  // Check lock
  const lockPath = path.join(outDir, 'bridgekit.lock');
  if (!existsSync(lockPath)) {
    diffs.push({ file: 'bridgekit.lock', reason: 'lock file missing from out-dir' });
  } else {
    let existingLock: LockFile | null = null;
    try {
      existingLock = JSON.parse(readFileSync(lockPath, 'utf8')) as LockFile;
    } catch {
      diffs.push({ file: 'bridgekit.lock', reason: 'lock file is malformed JSON' });
    }
    if (existingLock) {
      const lockDiffs = diffLocks(newLock, existingLock);
      for (const d of lockDiffs) {
        diffs.push({ file: 'bridgekit.lock', reason: `contract '${d.contract}': ${d.reason}` });
      }
    }
  }

  return diffs;
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

void mkdtempSync;
void readdirSync;
void rmSync;
void os;
