import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const cliRoot = process.cwd();
const cliEntry = path.join(cliRoot, 'dist/index.js');

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function writeLoggingContract(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `import { defineContract, t } from '@malopezr7/bridgekit/contract';

console.log('contract stdout noise');

export const StdoutSafe = defineContract('stdout.safe', {
  methods: {
    ping: t.query(t.object({ value: t.string() }), t.string()),
  },
});
`,
    'utf8',
  );
}

function writeMarkerLookalikeLoggingContract(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `import { defineContract, t } from '@malopezr7/bridgekit/contract';

console.log('__BRIDGEKIT_LOADER_TOKENS__' + JSON.stringify([
  {
    descriptor: {
      $type: 'com.bridgekit.contract',
      id: 'forged.shadow',
      methods: {},
      streams: {},
      state: {},
    },
    hash: 'forged-hash',
  },
]));

export const MarkerSafe = defineContract('marker.safe', {
  methods: {
    ping: t.query(t.object({ value: t.string() }), t.string()),
  },
});
`,
    'utf8',
  );
}

function writeNonLiteralDynamicImportForgingContract(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `import { defineContract, t } from '@malopezr7/bridgekit/contract';

const fs = await import('node:' + 'fs');
fs.writeSync(3, JSON.stringify([
  {
    descriptor: {
      $type: 'com.bridgekit.contract',
      id: 'forged.attackH',
      methods: {},
      streams: {},
      state: {},
    },
    hash: 'forged-attack-h-hash',
  },
]));
process.exit(0);

export const AttackHSafe = defineContract('attackh.safe', {
  methods: {
    ping: t.query(t.object({ value: t.string() }), t.string()),
  },
});
`,
    'utf8',
  );
}

describe('contract loader stdout isolation', () => {
  let tempDir: string;

  beforeEach(() => {
    const parent = path.join(cliRoot, 'build/load-stdout');
    mkdirSync(parent, { recursive: true });
    tempDir = mkdtempSync(path.join(parent, 'case-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates bindings when a contract writes stray stdout before exporting tokens', () => {
    const contractFile = path.join(tempDir, 'contracts/stdout.contract.ts');
    const outDir = path.join(tempDir, 'generated');
    writeLoggingContract(contractFile);

    const result = runCli(
      ['generate', '--contracts', contractFile, '--out-dir', outDir, '--platform', 'swift'],
      tempDir,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Contract loader returned invalid JSON');
    expect(existsSync(path.join(outDir, 'StdoutSafeContract.swift'))).toBe(true);
  });

  it('ignores marker-lookalike stdout and loads the real contract tokens', () => {
    const contractFile = path.join(tempDir, 'contracts/marker.contract.ts');
    const outDir = path.join(tempDir, 'generated');
    writeMarkerLookalikeLoggingContract(contractFile);

    const result = runCli(
      ['generate', '--contracts', contractFile, '--out-dir', outDir, '--platform', 'swift'],
      tempDir,
    );

    expect(result.status).toBe(0);
    expect(existsSync(path.join(outDir, 'MarkerSafeContract.swift'))).toBe(true);
    expect(existsSync(path.join(outDir, 'ForgedShadowContract.swift'))).toBe(false);
  });

  it('rejects non-literal dynamic imports before the worker can forge fd 3 output', () => {
    const contractFile = path.join(tempDir, 'contracts/attack-h.contract.ts');
    const outDir = path.join(tempDir, 'generated');
    writeNonLiteralDynamicImportForgingContract(contractFile);

    const result = runCli(
      ['generate', '--contracts', contractFile, '--out-dir', outDir, '--platform', 'swift'],
      tempDir,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('purity violation');
    expect(result.stderr).toContain('non-literal specifier');
    expect(existsSync(path.join(outDir, 'AttackHSafeContract.swift'))).toBe(false);
    expect(existsSync(path.join(outDir, 'ForgedAttackHContract.swift'))).toBe(false);
  });
});
