import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const describeOnMac = process.platform === 'darwin' ? describe : describe.skip;

const cliRoot = process.cwd();
const repoRoot = path.resolve(cliRoot, '../..');
const cliEntry = path.join(cliRoot, 'dist/index.js');
const swiftFrameworkDir = path.join(
  repoRoot,
  'packages/core/ios-facade/ios-arm64_x86_64-simulator',
);
const fixturesDir = path.join(cliRoot, 'src/__tests__/fixtures');

function ensureBuiltCli(): void {
  if (!existsSync(cliEntry)) {
    throw new Error(
      `CLI dist entry is missing. Run pnpm --filter @malopezr7/bridgekit-cli build before compiler harness tests: ${cliEntry}`,
    );
  }
}

function makeWorkspace(name: string): string {
  const parent = path.join(cliRoot, 'build/compile-swift');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, `${name}-`));
}

function generateSwift(contractFiles: Record<string, string>, name: string): string {
  ensureBuiltCli();
  const workspace = makeWorkspace(name);
  const contractsDir = path.join(workspace, 'contracts');
  const outDir = path.join(workspace, 'generated');
  mkdirSync(contractsDir, { recursive: true });

  for (const [fileName, source] of Object.entries(contractFiles)) {
    writeFileSync(path.join(contractsDir, fileName), source, 'utf8');
  }

  const result = spawnSync(
    process.execPath,
    [
      cliEntry,
      'generate',
      '--contracts',
      'contracts/*.contract.ts',
      '--out-dir',
      outDir,
      '--platform',
      'swift',
    ],
    { cwd: workspace, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(
      `Swift fixture generation failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }

  return outDir;
}

function generatedSwiftFiles(outDir: string): string[] {
  return readdirSync(outDir)
    .filter((fileName) => fileName.endsWith('.swift'))
    .map((fileName) => path.join(outDir, fileName));
}

function simulatorSdkPath(): string {
  const result = spawnSync('/usr/bin/xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `xcrun iphonesimulator SDK lookup failed (${result.status}):\n${result.stderr}`,
    );
  }

  return result.stdout.trim();
}

function swiftcTypecheck(filePath: string) {
  return spawnSync(
    '/usr/bin/swiftc',
    [
      '-typecheck',
      filePath,
      '-sdk',
      simulatorSdkPath(),
      '-target',
      'arm64-apple-ios15.0-simulator',
      '-F',
      swiftFrameworkDir,
      '-framework',
      'BridgeKit',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

describeOnMac('Swift real compiler harness', () => {
  it('proves a deliberately malformed baseline fails swiftc for a compiler reason', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'bridgekit-known-bad-swift-'));
    const badFile = path.join(workspace, 'KnownBad.swift');
    writeFileSync(
      badFile,
      'import BridgeKit\nfunc knownBad() { let value: String = 42 }\n',
      'utf8',
    );

    try {
      const result = swiftcTypecheck(badFile);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('cannot convert value of type');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('typechecks a known-good fixture with the committed BridgeKit simulator framework', () => {
    const outDir = generateSwift(
      {
        'known-good.contract.ts': `import { defineContract, t } from '@malopezr7/bridgekit/contract';\nexport const KnownGood = defineContract('compile.known-good', { methods: { greet: t.query(t.object({ name: t.string() }), t.string()) } });\n`,
      },
      'known-good',
    );

    const [swiftFile] = generatedSwiftFiles(outDir);
    expect(swiftFile).toBeDefined();

    const result = swiftcTypecheck(swiftFile as string);

    expect(result.status).toBe(0);
  });

  it('typechecks CLI-01 Swift enum result boundary decode', () => {
    const enumFixture = readFileSync(path.join(fixturesDir, 'schema-kinds.fixture.ts'), 'utf8');
    const outDir = generateSwift({ 'schema-kinds.contract.ts': enumFixture }, 'schema-kinds');
    const [swiftFile] = generatedSwiftFiles(outDir);
    expect(swiftFile).toBeDefined();

    const result = swiftcTypecheck(swiftFile as string);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output.trim()).toBe('');
  });
});
