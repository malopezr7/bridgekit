import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const cliRoot = process.cwd();
const repoRoot = path.resolve(cliRoot, '../..');
const cliEntry = path.join(cliRoot, 'dist/index.js');
const generatedRoot = path.join(cliRoot, 'build/generated-fixtures');
const goodFixturesDir = path.join(generatedRoot, 'kotlin-good');
const futureRedFixturesDir = path.join(generatedRoot, 'kotlin-red');
const knownBadFixturesDir = path.join(generatedRoot, 'kotlin-known-bad');
const stateRuntimeFixturesDir = path.join(generatedRoot, 'kotlin-state-runtime');
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
    [':app:compileDebugKotlin', `-PbridgekitGeneratedFixturesDir=${fixturesDir}`],
    { cwd: androidRoot, encoding: 'utf8', timeout: 15 * 60_000 },
  );
}

function writeKotlinStateRoundTripTest(fixturesDir: string): void {
  writeFileSync(
    path.join(fixturesDir, 'CompileStateCompoundRuntimeTest.kt'),
    `package com.bridgekit.generated.fixtures

import com.bridgekit.runtime.BridgeValue
import com.bridgekit.runtime.OutboundCaller
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class CompileStateCompoundRuntimeTest {
    @Test
    fun stateProviderEncodeAndCallerDecodeRoundTripCompoundValue() = runBlocking {
        val expected = Profile(
            id = "round-trip",
            tags = listOf("alpha", "beta"),
            updatedAt = Instant.parse("2024-03-04T05:06:07Z"),
            status = ProfileStatus.Active(
                since = Instant.parse("2024-03-05T06:07:08Z")
            )
        )
        val adapter = CompileStateCompoundContract.inbound(
            object : CompileStateCompound {
                override val large = MutableStateFlow(9_007_199_254_740_993L)
                override val initialDate = MutableStateFlow(Instant.parse("2024-03-04T05:06:07.890Z"))
                override val payload = MutableStateFlow(byteArrayOf(0, 1, 2, 254.toByte(), 255.toByte()))
                override val negativeZero = MutableStateFlow(-0.0)
                override val positiveZero = MutableStateFlow(0.0)
                override val emptyObject = MutableStateFlow(EmptyObject())
                override val emptyRecord = MutableStateFlow<Map<String, String>>(emptyMap())
                override val emptyArray = MutableStateFlow<List<String>>(emptyList())
                override val collections = MutableStateFlow(
                    Collections(CollectionsObject(), emptyMap(), emptyList())
                )
                override val profile = MutableStateFlow(expected)
            }
        )

        val initials = adapter.stateInitials
        val largeInitial = CompileStateCompoundContract.outbound(StateCaller(initials.getValue("large"))).large.first()
        assertTrue(largeInitial is BridgeValue.Available)
        assertEquals(9_007_199_254_740_993L, (largeInitial as BridgeValue.Available).value)

        val dateInitial = CompileStateCompoundContract.outbound(StateCaller(initials.getValue("initialDate"))).initialDate.first()
        assertTrue("date stateInitials value became unavailable", dateInitial is BridgeValue.Available)
        assertEquals(
            Instant.parse("2024-03-04T05:06:07.890Z"),
            (dateInitial as BridgeValue.Available).value
        )

        assertEquals("AAEC/v8=", initials.getValue("payload"))

        val negativeZeroInitial = CompileStateCompoundContract.outbound(StateCaller(initials.getValue("negativeZero"))).negativeZero.first()
        assertTrue(negativeZeroInitial is BridgeValue.Available)
        assertEquals(Double.NEGATIVE_INFINITY, 1.0 / (negativeZeroInitial as BridgeValue.Available).value, 0.0)
        val positiveZeroInitial = CompileStateCompoundContract.outbound(StateCaller(initials.getValue("positiveZero"))).positiveZero.first()
        assertTrue(positiveZeroInitial is BridgeValue.Available)
        assertEquals(Double.POSITIVE_INFINITY, 1.0 / (positiveZeroInitial as BridgeValue.Available).value, 0.0)

        val emptyObjectInitial = CompileStateCompoundContract.outbound(StateCaller(initials.getValue("emptyObject"))).emptyObject.first()
        assertTrue(emptyObjectInitial is BridgeValue.Available)
        val emptyRecordInitial = CompileStateCompoundContract.outbound(StateCaller(initials.getValue("emptyRecord"))).emptyRecord.first()
        assertTrue(emptyRecordInitial is BridgeValue.Available)
        assertTrue((emptyRecordInitial as BridgeValue.Available).value.isEmpty())
        val emptyArrayInitial = CompileStateCompoundContract.outbound(StateCaller(initials.getValue("emptyArray"))).emptyArray.first()
        assertTrue(emptyArrayInitial is BridgeValue.Available)
        assertTrue((emptyArrayInitial as BridgeValue.Available).value.isEmpty())
        val collectionsInitial = CompileStateCompoundContract.outbound(StateCaller(initials.getValue("collections"))).collections.first()
        assertTrue(collectionsInitial is BridgeValue.Available)
        val collections = (collectionsInitial as BridgeValue.Available).value
        assertTrue(collections.record.isEmpty())
        assertTrue(collections.array.isEmpty())

        val wire = adapter.stateFlows().getValue("profile").first()
        assertTrue("state provider must encode compound values to a wire map", wire is Map<*, *>)

        val client = CompileStateCompoundContract.outbound(StateCaller(wire))
        val decoded = client.profile.first()

        assertTrue(decoded is BridgeValue.Available)
        assertEquals(expected, (decoded as BridgeValue.Available).value)
    }
}

private class StateCaller(private val wire: Any?) : OutboundCaller {
    override suspend fun invoke(member: String, payload: Map<String, Any?>?): Any? = null
    override fun invokeSync(member: String, payload: Map<String, Any?>?): Any? = null
    override fun fire(member: String, payload: Map<String, Any?>?) = Unit
    override fun stream(member: String, payload: Map<String, Any?>?): Flow<Any?> = kotlinx.coroutines.flow.emptyFlow()
    override fun state(member: String): StateFlow<BridgeValue<Any?>> =
        MutableStateFlow(BridgeValue.Available(wire))
}
`,
    'utf8',
  );
}

function runGradleRuntimeTest(fixturesDir: string) {
  return spawnSync(
    './gradlew',
    [':malopezr7_bridgekit:testDebugUnitTest', `-PbridgekitGeneratedRuntimeTestDir=${fixturesDir}`],
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
      console.warn(
        'Skipping Kotlin known-bad compiler fixture gate. Set BRIDGEKIT_RUN_KOTLIN_NEGATIVE=1 to run it.',
      );
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

  it('runs CLI-02 Kotlin state provider encode and caller decode round-trip', () => {
    generateKotlin(
      {
        'state-compound.contract.ts': readFileSync(
          path.join(fixturesDir, 'state-compound.fixture.ts'),
          'utf8',
        ),
      },
      stateRuntimeFixturesDir,
    );
    writeKotlinStateRoundTripTest(stateRuntimeFixturesDir);

    const result = runGradleRuntimeTest(stateRuntimeFixturesDir);
    const output = `${result.stdout}\n${result.stderr}`;

    if (result.status !== 0) {
      throw new Error(`Kotlin state round-trip runtime gate failed (${result.status}):\n${output}`);
    }
    expect(result.status).toBe(0);
    expect(output).toContain('BUILD SUCCESSFUL');
  });

  it('generates CLI-03 Kotlin params collision with suffixed caller types', () => {
    generateKotlin(
      {
        'collision.contract.ts': readFileSync(
          path.join(fixturesDir, 'collision.fixture.ts'),
          'utf8',
        ),
      },
      futureRedFixturesDir,
    );

    const sourceFile = readdirSync(futureRedFixturesDir).find((fileName) => {
      return (
        fileName.endsWith('Contract.kt') &&
        readFileSync(path.join(futureRedFixturesDir, fileName), 'utf8').includes('fooBar')
      );
    });
    expect(sourceFile).toBeDefined();

    const source = readFileSync(path.join(futureRedFixturesDir, sourceFile as string), 'utf8');
    const suffixedParamsMatch = source.match(/data class (FooBarParams_[A-Za-z0-9_]+)\(/);
    expect(suffixedParamsMatch).not.toBeNull();
    const suffixedParams = suffixedParamsMatch?.[1] as string;
    expect(source).toContain(`suspend fun fooBar(params: ${suffixedParams}): String`);
    expect(source).toContain(`decode${suffixedParams}(payload ?: emptyMap<String, Any?>())`);
    expect(source).toContain(`encode${suffixedParams}(params)`);
  });

  it('compiles CLI-04 Kotlin keyword and literal escaping fixture', () => {
    generateKotlin(
      {
        'keywords.contract.ts': readFileSync(path.join(fixturesDir, 'keywords.fixture.ts'), 'utf8'),
      },
      futureRedFixturesDir,
    );

    const result = runGradleCompile(futureRedFixturesDir);
    const output = `${result.stdout}\n${result.stderr}`;

    if (result.status !== 0) {
      throw new Error(`Kotlin keyword/literal compiler gate failed (${result.status}):\n${output}`);
    }
    expect(result.status).toBe(0);
    expect(output).toContain('BUILD SUCCESSFUL');
  });
});
