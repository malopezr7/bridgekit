import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const cliRoot = process.cwd();
const repoRoot = path.resolve(cliRoot, '../..');
const cliEntry = path.join(cliRoot, 'dist/index.js');
const generatedRoot = path.join(cliRoot, 'build/generated-fixtures');
const goodFixturesDir = path.join(generatedRoot, 'kotlin-good');
const futureRedFixturesDir = path.join(generatedRoot, 'kotlin-red');
const knownBadFixturesDir = path.join(generatedRoot, 'kotlin-known-bad');
const androidRoot = path.join(repoRoot, 'apps/example/android');
const fixturesDir = path.join(cliRoot, 'src/__tests__/fixtures');

function ensureBuiltCli(): void {
  if (!existsSync(cliEntry)) {
    throw new Error(
      `CLI dist entry is missing. Run pnpm --filter @malopezr7/bridgekit-cli build before compiler harness tests: ${cliEntry}`,
    );
  }
}

function generateKotlin(contractFiles: Record<string, string>, outDir: string): void {
  ensureBuiltCli();
  const contractsDir = path.join(generatedRoot, 'contracts', path.basename(outDir));
  rmSync(contractsDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
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
      `${contractsDir}/*.contract.ts`,
      '--out-dir',
      outDir,
      '--platform',
      'kotlin',
      '--package',
      'com.bridgekit.generated.fixtures',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(
      `Kotlin fixture generation failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function runGradleCompile(fixturesDir: string) {
  return spawnSync(
    './gradlew',
    [
      ':app:compileDebugKotlin',
      `-PbridgekitGeneratedFixturesDir=${fixturesDir}`,
      '-PbridgekitGeneratedWarningsAsErrors=true',
    ],
    { cwd: androidRoot, encoding: 'utf8', timeout: 15 * 60_000 },
  );
}

describe('Kotlin real compiler harness', () => {
  it('generates a known-good fixture directory for the example app Gradle gate', () => {
    generateKotlin(
      {
        'known-good.contract.ts': `import { defineContract, t } from '@malopezr7/bridgekit/contract';\nexport const KnownGood = defineContract('compile.kotlin-good', { methods: { greet: t.query(t.object({ name: t.string() }), t.string()) } });\n`,
      },
      goodFixturesDir,
    );

    expect(existsSync(path.join(goodFixturesDir, 'CompileKotlinGoodContract.kt'))).toBe(true);
  });

  it('generates future RED fixture sources for state, collision, and keyword slices', () => {
    generateKotlin(
      {
        'state-compound.contract.ts': readFileSync(
          path.join(fixturesDir, 'state-compound.fixture.ts'),
          'utf8',
        ),
        'collision.contract.ts': readFileSync(
          path.join(fixturesDir, 'collision.fixture.ts'),
          'utf8',
        ),
        'keywords.contract.ts': readFileSync(path.join(fixturesDir, 'keywords.fixture.ts'), 'utf8'),
      },
      futureRedFixturesDir,
    );

    expect(existsSync(path.join(futureRedFixturesDir, 'CompileStateCompoundContract.kt'))).toBe(
      true,
    );
    expect(existsSync(path.join(futureRedFixturesDir, 'CompileKeywordsContract.kt'))).toBe(true);
  });

  it('proves a deliberately malformed baseline fails Gradle for a compiler reason', () => {
    if (process.env.BRIDGEKIT_RUN_KOTLIN_NEGATIVE !== '1') {
      return;
    }

    rmSync(knownBadFixturesDir, { recursive: true, force: true });
    const packageDir = path.join(knownBadFixturesDir, 'com/bridgekit/generated/fixtures');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(packageDir, 'KnownBad.kt'),
      'package com.bridgekit.generated.fixtures\n\nfun knownBad(): String = 42\n',
      'utf8',
    );

    const result = runGradleCompile(knownBadFixturesDir);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/Compilation error|type mismatch|compileDebugKotlin/);
  });
});
