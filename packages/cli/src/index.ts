#!/usr/bin/env node
// ---------------------------------------------------------------------------
// src/index.ts — `bridgekit` entry point
// ---------------------------------------------------------------------------

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './cliError.js';
import { dim, ok, warn } from './theme.js';
import { checkDrift } from './check.js';
import { contractIdToPackage, emitKotlinContract } from './emit/kotlin.js';
import { emitSwiftContract } from './emit/swift.js';
import type { RawContractToken } from './load.js';
import { loadContractsFromFile } from './load.js';
import { buildLock, writeLock } from './lock.js';

// ---- help ------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(
    [
      '',
      'Usage',
      '  bridgekit <subcommand> [options]',
      '',
      'Subcommands',
      '  generate    Emit Kotlin/Swift files from contract definitions',
      '',
      'Options (generate)',
      '  --contracts <glob>    Glob for contract files (default: **/*.contract.ts)',
      '  --out-dir <path>      Output directory (default: bridgekit/generated)',
      '  --package <pkg>       Kotlin package override (default: derived from contract id)',
      '  --check               Diff against out-dir instead of writing; exit 1 on drift',
      '  --into <path>         Mirror output to this path after generating',
      '  --platform <k|s>      Target platform: kotlin (default) or swift',
      '',
      'Examples',
      '  bridgekit generate',
      '  bridgekit generate --contracts "src/**/*.contract.ts" --out-dir android/bridgekit',
      '  bridgekit generate --check',
      '  bridgekit generate --platform swift --out-dir ios/bridgekit',
      '  bridgekit generate --into ../Android.Application/features/lia/bridgekit',
      '',
    ].join('\n'),
  );
}

// ---- option parsing --------------------------------------------------------

interface BridgekitOptions {
  contracts: string;
  outDir: string;
  kotlinPackage?: string;
  check: boolean;
  into?: string;
  platform: 'kotlin' | 'swift';
}

function parseArgs(args: string[]): BridgekitOptions {
  const opts: BridgekitOptions = {
    contracts: '**/*.contract.ts',
    outDir: 'bridgekit/generated',
    check: false,
    platform: 'kotlin',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    switch (arg) {
      case '--contracts':
        opts.contracts = args[++i] ?? '';
        break;
      case '--out-dir':
        opts.outDir = args[++i] ?? '';
        break;
      case '--package':
        opts.kotlinPackage = args[++i];
        break;
      case '--check':
        opts.check = true;
        break;
      case '--into':
        opts.into = args[++i];
        break;
      case '--platform': {
        const p = args[++i] ?? '';
        if (p !== 'kotlin' && p !== 'swift') {
          throw new CliError(`--platform must be 'kotlin' or 'swift', got: ${p}`);
        }
        opts.platform = p;
        break;
      }
      default:
        throw new CliError(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

// ---- glob with exclusions --------------------------------------------------

async function findContractFiles(pattern: string, cwd: string): Promise<string[]> {
  const files: string[] = [];

  // Use Node 26 native fs.glob
  for await (const entry of glob(pattern, {
    cwd,
    exclude: (f) => {
      const normalized = f.replace(/\\/g, '/');
      return normalized.includes('node_modules') || normalized.includes('/dist/');
    },
  })) {
    files.push(path.resolve(cwd, entry));
  }

  return files.sort();
}

// ---- generate --------------------------------------------------------------

async function runGenerate(opts: BridgekitOptions, cwd: string): Promise<number> {
  // Validate --into if provided
  if (opts.into !== undefined) {
    const intoPath = path.resolve(cwd, opts.into);
    if (!existsSync(intoPath)) {
      throw new CliError(`--into path does not exist: ${intoPath}. Create the directory first.`);
    }
  }

  // Find contract files
  const contractFiles = await findContractFiles(opts.contracts, cwd);
  if (contractFiles.length === 0) {
    process.stderr.write(warn(`No contract files found matching: ${opts.contracts}\n`));
    return 0;
  }

  // Load contracts via runtime import (schema-first path)
  const tokens: RawContractToken[] = [];

  for (const file of contractFiles) {
    const fileTokens = await loadContractsFromFile(file);
    tokens.push(...fileTokens);
  }

  if (tokens.length === 0) {
    process.stderr.write(warn(`No BridgeContract tokens found in matched files.\n`));
    return 0;
  }

  // Emit contracts (Kotlin or Swift)
  const emitResults = tokens.map((token) => {
    if (opts.platform === 'swift') {
      return emitSwiftContract(token, contractIdToPackage(token.descriptor.id, opts.kotlinPackage));
    }
    return emitKotlinContract(token, contractIdToPackage(token.descriptor.id, opts.kotlinPackage));
  });

  // Build lock
  const lock = buildLock(tokens, opts.platform);

  // --check mode: diff and exit
  if (opts.check) {
    const outDir = path.resolve(cwd, opts.outDir);
    const diffs = checkDrift(emitResults, lock, outDir);
    if (diffs.length === 0) {
      process.stdout.write(ok('No drift detected. Contract bindings are up to date.\n'));
      return 0;
    }
    const langLabel = opts.platform === 'swift' ? 'Swift' : 'Kotlin';
    process.stderr.write(warn(`Drift detected in generated ${langLabel} bindings:\n`));
    for (const d of diffs) {
      process.stderr.write(`  ${d.file}: ${d.reason}\n`);
    }
    process.stderr.write(
      dim('\nRun `bridgekit generate` to regenerate and commit the result.\n'),
    );
    return 1;
  }

  // Write mode
  const outDir = path.resolve(cwd, opts.outDir);
  mkdirSync(outDir, { recursive: true });

  for (const result of emitResults) {
    const outPath = path.join(outDir, result.fileName);
    writeFileSync(outPath, result.content, 'utf8');
    process.stdout.write(ok(`  ✔ ${result.fileName}\n`));
  }

  writeLock(outDir, lock);
  process.stdout.write(ok(`  ✔ bridgekit.lock\n`));

  process.stdout.write(`\nGenerated ${emitResults.length} contract file(s) to ${dim(outDir)}\n`);

  // --into: mirror
  if (opts.into !== undefined) {
    const intoPath = path.resolve(cwd, opts.into);
    const files = readdirSync(outDir);
    for (const f of files) {
      cpSync(path.join(outDir, f), path.join(intoPath, f));
    }
    process.stdout.write(ok(`Mirrored ${files.length} file(s) to ${dim(intoPath)}\n`));
  }

  return 0;
}

// ---- entry point -----------------------------------------------------------

export async function runBridgekitCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printHelp();
    return 0;
  }

  // Catch bare flags (not subcommands) passed as first arg
  if (subcommand.startsWith('-') && subcommand !== '--help' && subcommand !== '-h') {
    throw new CliError(`Unknown option: ${subcommand}`);
  }

  if (subcommand === 'generate') {
    const hasHelp = rest.includes('--help') || rest.includes('-h');
    if (hasHelp) {
      printHelp();
      return 0;
    }
    const opts = parseArgs(rest);
    return runGenerate(opts, process.cwd());
  }

  throw new CliError(`Unknown bridgekit subcommand: ${subcommand}`);
}

// Run when executed directly
const args = process.argv.slice(2);
runBridgekitCommand(args).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof CliError) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`Unexpected error: ${String(err)}\n`);
    process.exit(1);
  },
);
