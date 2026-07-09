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
});
