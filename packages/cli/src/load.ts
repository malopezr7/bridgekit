// ---------------------------------------------------------------------------
// load.ts — Load *.contract.ts files by spawning a child ESM process.
//
// The CLI binary compiles to CJS. Dynamic import() of .ts files from CJS
// gets compiled by babel to require(), which never hits the ESM loader.
//
// Solution: write a tiny ESM loader script to a temp file and spawn it
// with --experimental-strip-types. The script registers hooks for
// extensionless .ts imports, imports the contract file, collects tokens
// by duck-typing, and serializes to stdout as JSON.
//
// Purity check (DESIGN §2.3) runs in the parent before spawning.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { CliError } from './cliError.js';

// ---- duck-typed contract shape (never import bridgekit classes) -------------

export interface RawContractToken {
  descriptor: {
    $type: 'com.bridgekit.contract';
    id: string;
    methods: Record<string, unknown>;
    streams: Record<string, unknown>;
    state: Record<string, unknown>;
  };
  hash: string;
}

// ---- purity check -----------------------------------------------------------

const ALLOWED_SPECIFIER_REGEX = /^@malopezr7\/bridgekit\/contract/;

/**
 * Scan import statements in a .ts file and fail if any import is not:
 * - '@malopezr7/bridgekit/contract'
 *
 * Returns violation messages in file:line format.
 */
function checkFilePurity(filePath: string): string[] {
  const violations: string[] = [];
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch {
    return [`${filePath}: cannot read file`];
  }

  for (const match of findImportSpecifiers(source)) {
    const line = lineNumberForOffset(source, match.index);
    if (match.specifier.startsWith('.')) {
      violations.push(
        `${filePath}:${line}: purity violation — relative import '${match.specifier}' is not allowed`,
      );
    } else if (!ALLOWED_SPECIFIER_REGEX.test(match.specifier)) {
      violations.push(
        `${filePath}:${line}: purity violation — disallowed import '${match.specifier}'`,
      );
    }
  }

  return violations;
}

function findImportSpecifiers(source: string): Array<{ specifier: string; index: number }> {
  const matches: Array<{ specifier: string; index: number }> = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s+(?:type\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) {
        matches.push({ specifier, index: match.index ?? 0 });
      }
    }
  }

  return matches;
}

function lineNumberForOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

// ---- ESM worker script (written to temp file, never compiled by babel) ------

const WORKER_SCRIPT = `
import { createRequire } from 'node:module';
import { existsSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

// Pre-resolve @malopezr7/bridgekit/contract to its CJS dist using the file being
// loaded as the resolution base, so that --experimental-strip-types is not
// applied to node_modules (which Node 26 refuses to do).
// This is looked up lazily on first resolution so the worker doesn't fail if
// the package is not installed in the caller's project (codegen inside the
// monorepo itself falls back normally).
let _bridgekitContractCjsUrl = null;
function getBridgekitContractUrl(contractFilePath) {
  if (_bridgekitContractCjsUrl !== null) return _bridgekitContractCjsUrl;
  try {
    const req = createRequire(contractFilePath);
    const resolved = req.resolve('@malopezr7/bridgekit/contract');
    _bridgekitContractCjsUrl = pathToFileURL(resolved).href;
  } catch {
    _bridgekitContractCjsUrl = undefined;
  }
  return _bridgekitContractCjsUrl;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Redirect @malopezr7/bridgekit/contract to the pre-built CJS dist so that
    // --experimental-strip-types is not applied to the .ts source under node_modules.
    if (specifier === '@malopezr7/bridgekit/contract') {
      const contractFilePath = process.argv[2];
      const url = getBridgekitContractUrl(contractFilePath);
      if (url) return { url, shortCircuit: true };
    }

    if (
      typeof specifier === 'string' &&
      specifier.startsWith('.') &&
      !specifier.endsWith('.ts') &&
      !specifier.endsWith('.js') &&
      !specifier.endsWith('.mjs') &&
      !specifier.endsWith('.cjs') &&
      !specifier.endsWith('.json')
    ) {
      const parentPath = context.parentURL
        ? new URL(context.parentURL).pathname
        : process.cwd() + '/';
      const parentDir = dirname(parentPath);
      const candidate = resolve(parentDir, specifier + '.ts');
      if (existsSync(candidate)) {
        return nextResolve(specifier + '.ts', context);
      }
    }
    return nextResolve(specifier, context);
  }
});

const filePath = process.argv[2];
if (!filePath) {
  process.stderr.write('loader-worker: missing file path\\n');
  process.exit(1);
}

const fileUrl = pathToFileURL(filePath).href;
let mod;
try {
  mod = await import(fileUrl);
} catch(err) {
  process.stderr.write('loader-worker: import failed: ' + err.message + '\\n');
  process.exit(1);
}

function isToken(value) {
  // DX-1: defineContract returns a frozen callable (typeof === 'function') that
  // carries descriptor + hash as own properties. Accept both objects and functions.
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (typeof value.hash !== 'string') return false;
  const d = value.descriptor;
  if (d === null || typeof d !== 'object') return false;
  return d.$type === 'com.bridgekit.contract' && typeof d.id === 'string';
}

const tokens = [];
for (const [, value] of Object.entries(mod)) {
  if (isToken(value)) {
    tokens.push({ descriptor: value.descriptor, hash: value.hash });
  }
}

writeSync(3, JSON.stringify(tokens));
`;

// ---- load contracts from a file --------------------------------------------

/**
 * Load all BridgeContract tokens from a .ts contract file.
 * Enforces the purity rule before loading.
 */
export async function loadContractsFromFile(filePath: string): Promise<RawContractToken[]> {
  if (!isAbsolute(filePath)) {
    filePath = resolve(process.cwd(), filePath);
  }
  if (!existsSync(filePath)) {
    throw new CliError(`Contract file not found: ${filePath}`);
  }

  // Purity check (runs in parent, no import needed)
  const violations = checkFilePurity(filePath);
  if (violations.length > 0) {
    throw new CliError(
      `Purity rule violation in contract file(s):\n${violations.map((v) => `  ${v}`).join('\n')}`,
      1,
    );
  }

  // Write ESM worker to temp file
  const tmpDir = mkdtempSync(join(tmpdir(), 'bridgekit-loader-'));
  const workerPath = join(tmpDir, 'worker.mjs');
  try {
    writeFileSync(workerPath, WORKER_SCRIPT, 'utf8');

    // Spawn worker with TS stripping enabled. fd 3 is the out-of-band token channel;
    // user contract stdout stays on fd 1 and cannot corrupt the protocol payload.
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', workerPath, filePath],
      {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      },
    );

    if (result.error) {
      throw new CliError(`Failed to spawn contract loader: ${result.error.message}`);
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      throw new CliError(`Failed to load contract file ${filePath}:\n${stderr}`);
    }

    const tokenPayload = result.output[3];
    if (typeof tokenPayload !== 'string' || tokenPayload.length === 0) {
      throw new CliError(
        `Contract loader returned no protocol payload for ${filePath}: ${result.stdout.substring(0, 200)}`,
      );
    }

    let tokens: unknown[];
    try {
      tokens = JSON.parse(tokenPayload) as unknown[];
    } catch {
      throw new CliError(
        `Contract loader returned invalid JSON for ${filePath}: ${tokenPayload.substring(0, 200)}`,
      );
    }

    return tokens.filter(isBridgeContractToken) as RawContractToken[];
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

function isBridgeContractToken(value: unknown): value is RawContractToken {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.hash !== 'string') return false;
  const desc = obj.descriptor;
  if (desc === null || typeof desc !== 'object') return false;
  const d = desc as Record<string, unknown>;
  return d.$type === 'com.bridgekit.contract' && typeof d.id === 'string';
}
