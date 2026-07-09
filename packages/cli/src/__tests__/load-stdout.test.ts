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

function writeNonceForgingLoggingContract(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `import { defineContract, t } from '@malopezr7/bridgekit/contract';

const nonce = process.env.BRIDGEKIT_TOKEN_NONCE;
if (nonce) {
  console.log('__BRIDGEKIT_LOADER_TOKENS__' + nonce + JSON.stringify([
    {
      descriptor: {
        $type: 'com.bridgekit.contract',
        id: 'forged.nonce',
        methods: {},
        streams: {},
        state: {},
      },
      hash: 'forged-nonce-hash',
    },
  ]));
}

export const NonceSafe = defineContract('nonce.safe', {
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

  it('ignores nonce-forged stdout and loads the real contract tokens', () => {
    const contractFile = path.join(tempDir, 'contracts/nonce.contract.ts');
    const outDir = path.join(tempDir, 'generated');
    writeNonceForgingLoggingContract(contractFile);

    const result = runCli(
      ['generate', '--contracts', contractFile, '--out-dir', outDir, '--platform', 'swift'],
      tempDir,
    );

    expect(result.status).toBe(0);
    expect(existsSync(path.join(outDir, 'NonceSafeContract.swift'))).toBe(true);
    expect(existsSync(path.join(outDir, 'ForgedNonceContract.swift'))).toBe(false);
  });
});
