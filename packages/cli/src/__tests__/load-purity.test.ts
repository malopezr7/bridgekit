import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadContractsFromFile } from '../load.js';

const cliRoot = process.cwd();
const repoRoot = path.resolve(cliRoot, '../..');
const cliEntry = path.join(cliRoot, 'dist/index.js');

function runCli(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function gitStatus(): string {
  return spawnSync('git', ['status', '--short'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout;
}

function writePureContract(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `import { defineContract, t } from '@malopezr7/bridgekit/contract';

export const FlagSafe = defineContract('flag.safe', {
  methods: {
    ping: t.query(t.object({ value: t.string() }), t.string()),
  },
});
`,
    'utf8',
  );
}

function writeEvilModule(filePath: string, markerPath: string): void {
  writeFileSync(
    filePath,
    `import { writeFileSync } from 'node:fs';

writeFileSync(${JSON.stringify(markerPath)}, 'executed', 'utf8');
export const marker = 'evil';
`,
    'utf8',
  );
}

async function expectPurityRejection(contractSource: string): Promise<void> {
  const workspace = mkdtempSync(path.join(cliRoot, 'build/load-purity-case-'));
  const markerPath = path.join(workspace, 'evil-ran.txt');
  const contractPath = path.join(workspace, 'impure.contract.ts');
  try {
    writeEvilModule(path.join(workspace, 'evil.ts'), markerPath);
    writeFileSync(contractPath, contractSource, 'utf8');

    await expect(loadContractsFromFile(contractPath)).rejects.toThrow(/Purity rule violation/);
    expect(existsSync(markerPath)).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe('contract loader purity checks', () => {
  beforeEach(() => {
    mkdirSync(path.join(cliRoot, 'build'), { recursive: true });
  });

  it('rejects multiline relative imports before executing imported code', async () => {
    await expectPurityRejection(`import { defineContract, t } from '@malopezr7/bridgekit/contract';
import {
  marker,
} from './evil';

export const Impure = defineContract('impure.multiline', {
  methods: {
    ping: t.query(t.object({ value: t.string() }), t.string()),
  },
});
void marker;
`);
  });

  it('rejects CommonJS relative require before worker execution', async () => {
    await expectPurityRejection(`import { defineContract, t } from '@malopezr7/bridgekit/contract';

require('./evil');

export const Impure = defineContract('impure.require', {
  methods: {
    ping: t.query(t.object({ value: t.string() }), t.string()),
  },
});
`);
  });

  it('rejects relative export-star re-exports before executing the re-exported module', async () => {
    await expectPurityRejection(`import { defineContract, t } from '@malopezr7/bridgekit/contract';
export * from './evil';

export const Impure = defineContract('impure.export', {
  methods: {
    ping: t.query(t.object({ value: t.string() }), t.string()),
  },
});
`);
  });

  it('rejects relative NodeNext .js specifiers before worker execution', async () => {
    await expectPurityRejection(`import { defineContract, t } from '@malopezr7/bridgekit/contract';
import { marker } from './evil.js';

export const Impure = defineContract('impure.nodenext', {
  methods: {
    ping: t.query(t.object({ value: t.string() }), t.string()),
  },
});
void marker;
`);
  });

  it('allows import-like text inside comments and string literals', async () => {
    const workspace = mkdtempSync(path.join(cliRoot, 'build/load-purity-comment-'));
    const contractPath = path.join(workspace, 'comment.contract.ts');
    try {
      writeFileSync(
        contractPath,
        `import { defineContract, t } from '@malopezr7/bridgekit/contract';

// Documentation note: do not write import(x) in real code.
const guidance = 'avoid require(x) in contract files';

export const CommentSafe = defineContract('comment.safe', {
  methods: {
    ping: t.query(t.object({ value: t.string() }), t.string()),
  },
});
void guidance;
`,
        'utf8',
      );

      await expect(loadContractsFromFile(contractPath)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            descriptor: expect.objectContaining({ id: 'comment.safe' }),
          }),
        ]),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('missing CLI flag values', () => {
  let tempDir: string;
  let rootStatusBefore: string;

  beforeEach(() => {
    const parent = path.join(cliRoot, 'build/load-purity');
    mkdirSync(parent, { recursive: true });
    tempDir = mkdtempSync(path.join(parent, 'flags-'));
    writePureContract(path.join(tempDir, 'flag.contract.ts'));
    rootStatusBefore = gitStatus();
  });

  afterEach(() => {
    for (const fileName of readdirSync(repoRoot)) {
      if (/FlagSafeContract\.(kt|swift)$/.test(fileName) || fileName === 'bridgekit.lock') {
        rmSync(path.join(repoRoot, fileName), { force: true });
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('errors when --package has no value and leaves the repo root unchanged', () => {
    const result = runCli([
      'generate',
      '--contracts',
      path.join(tempDir, 'flag.contract.ts'),
      '--out-dir',
      path.join(tempDir, 'generated'),
      '--platform',
      'kotlin',
      '--package',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--package requires a value');
    expect(gitStatus()).toBe(rootStatusBefore);
  });

  it('errors when --out-dir has no value and leaves the repo root unchanged', () => {
    const result = runCli([
      'generate',
      '--contracts',
      path.join(tempDir, 'flag.contract.ts'),
      '--platform',
      'kotlin',
      '--package',
      'com.bridgekit.generated',
      '--out-dir',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--out-dir requires a value');
    expect(gitStatus()).toBe(rootStatusBefore);
  });
});
