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

function swiftcExecutable(sourcePath: string, outputPath: string) {
  return spawnSync('/usr/bin/swiftc', ['-parse-as-library', sourcePath, '-o', outputPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function swiftBridgeKitStubs(): string {
  return `
import Foundation

public struct BridgeKitDecodeError: Error {
    public let field: String
    public let expectedType: String
    public init(field: String, expectedType: String) {
        self.field = field
        self.expectedType = expectedType
    }
}

public func bridgeKitThrow<T>(field: String, expectedType: String) throws -> T {
    throw BridgeKitDecodeError(field: field, expectedType: expectedType)
}

public enum BridgeValue<T> {
    case available(T)
    case initial(T)
    case replacing(T?)
    case unprovided(T?)

    public func remap<U>(_ transform: (T) -> U?) -> BridgeValue<U> {
        switch self {
        case .available(let value): return transform(value).map(BridgeValue<U>.available) ?? .unprovided(nil)
        case .initial(let value): return transform(value).map(BridgeValue<U>.initial) ?? .unprovided(nil)
        case .replacing(let last): return .replacing(last.flatMap(transform))
        case .unprovided(let last): return .unprovided(last.flatMap(transform))
        }
    }
}

public protocol OutboundCaller: AnyObject {
    func invoke(member: String, payload: [String: Any?]?) async throws -> Any?
    func invokeSync(member: String, payload: [String: Any?]?) throws -> Any?
    func fire(member: String, payload: [String: Any?]?)
    func stream(member: String, payload: [String: Any?]?) -> AsyncThrowingStream<Any?, Error>
    func state(member: String) -> AsyncStream<BridgeValue<Any?>>
}

public protocol InboundContractAdapter: AnyObject {
    var stateInitials: [String: Any?] { get }
    func invoke(member: String, payload: [String: Any?]?) async throws -> Any?
    func invokeSync(member: String, payload: [String: Any?]?) throws -> Any?
    func openStream(member: String, payload: [String: Any?]?) -> AsyncThrowingStream<Any?, Error>
    func stateStreams() -> [String: AsyncStream<Any?>]
}

open class BridgeContractDefinition<P, C> {
    public let id: String
    public let contractHash: String
    public let memberHashes: [String: String]
    public init(id: String, contractHash: String, memberHashes: [String: String]) {
        self.id = id
        self.contractHash = contractHash
        self.memberHashes = memberHashes
    }
    open func inbound(_ impl: P) -> InboundContractAdapter { fatalError("override required") }
    open func outbound(_ caller: OutboundCaller) -> C { fatalError("override required") }
}
`;
}

function swiftStateRoundTripMain(): string {
  return `
func oneValue<T>(_ value: T) -> AsyncStream<T> {
    AsyncStream { cont in
        cont.yield(value)
        cont.finish()
    }
}

final class StateProvider: CompileStateCompound {
    let profileValue: Profile
    init(_ value: Profile) { self.profileValue = value }
    var large: AsyncStream<Int64> { oneValue(9_007_199_254_740_993) }
    var initialDate: AsyncStream<Date> { oneValue(Date(timeIntervalSince1970: 1_709_528_767.890)) }
    var payload: AsyncStream<Data> { oneValue(Data([0, 1, 2, 254, 255])) }
    var emptyObject: AsyncStream<EmptyObject> { oneValue(EmptyObject()) }
    var emptyRecord: AsyncStream<[String: String]> { oneValue([:]) }
    var emptyArray: AsyncStream<[String]> { oneValue([]) }
    var collections: AsyncStream<Collections> {
        oneValue(Collections(object: CollectionsObject(), record: [:], array: []))
    }
    var profile: AsyncStream<Profile> { oneValue(profileValue) }
}

final class StateCaller: OutboundCaller {
    let wire: Any?
    init(_ wire: Any?) { self.wire = wire }
    func invoke(member: String, payload: [String: Any?]?) async throws -> Any? { nil }
    func invokeSync(member: String, payload: [String: Any?]?) throws -> Any? { nil }
    func fire(member: String, payload: [String: Any?]?) {}
    func stream(member: String, payload: [String: Any?]?) -> AsyncThrowingStream<Any?, Error> {
        AsyncThrowingStream { cont in cont.finish() }
    }
    func state(member: String) -> AsyncStream<BridgeValue<Any?>> {
        AsyncStream { cont in
            cont.yield(.available(wire))
            cont.finish()
        }
    }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\\n").data(using: .utf8)!)
    Foundation.exit(1)
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fail(message) }
}

func requireDate(_ value: Any?, millis: Int64, _ label: String) {
    if let number = value as? NSNumber {
        require(number.int64Value == millis, "\\(label) expected epoch millis \\(millis), got \\(number)")
    } else if let int = value as? Int64 {
        require(int == millis, "\\(label) expected epoch millis \\(millis), got \\(int)")
    } else if let int = value as? Int {
        require(Int64(int) == millis, "\\(label) expected epoch millis \\(millis), got \\(int)")
    } else {
        fail("\\(label) expected numeric epoch millis, got \\(String(describing: value))")
    }
}

func requireProfileEqual(_ actual: Profile, _ expected: Profile) {
    require(actual.id == expected.id, "decoded id mismatch")
    require(actual.tags == expected.tags, "decoded tags mismatch")
    require(actual.updatedAt == expected.updatedAt, "decoded updatedAt mismatch")
    switch (actual.status, expected.status) {
    case (.active(let actualValue), .active(let expectedValue)):
        require(actualValue.since == expectedValue.since, "decoded union date mismatch")
    default:
        fail("decoded union variant mismatch")
    }
}

func firstValue<T>(_ stream: AsyncStream<BridgeValue<T>>) async -> BridgeValue<T>? {
    for await value in stream { return value }
    return nil
}

@main
struct StateRoundTripMain {
    static func main() async {
        let expected = Profile(
            id: "round-trip",
            tags: ["alpha", "beta"],
            updatedAt: Date(timeIntervalSince1970: 1709528767),
            status: .active(ProfileStatusActive(since: Date(timeIntervalSince1970: 1709618828)))
        )
        let adapter = CompileStateCompoundContract().inbound(StateProvider(expected))
        let initials = adapter.stateInitials

        let largeClient = CompileStateCompoundContract().outbound(StateCaller(initials["large"] ?? nil))
        guard case .available(let large)? = await firstValue(largeClient.large) else {
            fail("int64 stateInitials value did not decode")
        }
        require(large == 9_007_199_254_740_993, "int64 stateInitials mismatch")

        let dateClient = CompileStateCompoundContract().outbound(StateCaller(initials["initialDate"] ?? nil))
        guard case .available(let date)? = await firstValue(dateClient.initialDate) else {
            fail("date stateInitials value became unavailable")
        }
        require(date.timeIntervalSince1970 == 1_709_528_767.890, "date stateInitials epoch mismatch")

        let binaryClient = CompileStateCompoundContract().outbound(StateCaller(initials["payload"] ?? nil))
        guard case .available(let payload)? = await firstValue(binaryClient.payload) else {
            fail("binary stateInitials value did not decode")
        }
        require(payload == Data([0, 1, 2, 254, 255]), "binary stateInitials bytes mismatch")

        let emptyObjectClient = CompileStateCompoundContract().outbound(StateCaller(initials["emptyObject"] ?? nil))
        guard case .available(_)? = await firstValue(emptyObjectClient.emptyObject) else {
            fail("empty object stateInitials value did not decode")
        }
        let emptyRecordClient = CompileStateCompoundContract().outbound(StateCaller(initials["emptyRecord"] ?? nil))
        guard case .available(let emptyRecord)? = await firstValue(emptyRecordClient.emptyRecord) else {
            fail("empty record stateInitials value did not decode")
        }
        require(emptyRecord.isEmpty, "empty record stateInitials mismatch")
        let emptyArrayClient = CompileStateCompoundContract().outbound(StateCaller(initials["emptyArray"] ?? nil))
        guard case .available(let emptyArray)? = await firstValue(emptyArrayClient.emptyArray) else {
            fail("empty array stateInitials value did not decode")
        }
        require(emptyArray.isEmpty, "empty array stateInitials mismatch")
        let collectionsClient = CompileStateCompoundContract().outbound(StateCaller(initials["collections"] ?? nil))
        guard case .available(let collections)? = await firstValue(collectionsClient.collections) else {
            fail("nested collection stateInitials value did not decode")
        }
        require(collections.record.isEmpty && collections.array.isEmpty, "nested collection stateInitials mismatch")
        guard let stream = adapter.stateStreams()["profile"] else { fail("missing profile state stream") }

        var wire: Any? = nil
        for await item in stream {
            wire = item
            break
        }

        guard let wireMap = wire as? [String: Any?] else {
            fail("state provider must encode compound values to a wire dictionary, got \\(String(describing: wire))")
        }
        require(wireMap["id"] as? String == expected.id, "encoded id mismatch")
        require(wireMap["tags"] as? [String] == expected.tags, "encoded tags mismatch")
        requireDate(wireMap["updatedAt"] ?? nil, millis: 1709528767000, "encoded updatedAt")
        guard let statusMap = wireMap["status"] as? [String: Any?] else { fail("encoded union is not a dictionary") }
        require(statusMap["kind"] as? String == "active", "encoded union discriminant mismatch")
        requireDate(statusMap["since"] ?? nil, millis: 1709618828000, "encoded union date")

        let client = CompileStateCompoundContract().outbound(StateCaller(wireMap))
        var decoded: BridgeValue<Profile>? = nil
        for await value in client.profile {
            decoded = value
            break
        }
        guard case .available(let actual)? = decoded else { fail("decoded state was not available") }
        requireProfileEqual(actual, expected)
    }
}
`;
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

  it('executes CLI-02 Swift state provider encode and caller decode round-trip', () => {
    const stateFixture = readFileSync(path.join(fixturesDir, 'state-compound.fixture.ts'), 'utf8');
    const outDir = generateSwift({ 'state-compound.contract.ts': stateFixture }, 'state-compound');
    const [swiftFile] = generatedSwiftFiles(outDir);
    expect(swiftFile).toBeDefined();

    const workspace = makeWorkspace('state-round-trip-runtime');
    const programPath = path.join(workspace, 'StateRoundTrip.swift');
    const binPath = path.join(workspace, 'StateRoundTrip');
    const generatedSource = readFileSync(swiftFile as string, 'utf8').replace(
      /^import BridgeKit\n/m,
      '',
    );
    writeFileSync(
      programPath,
      [swiftBridgeKitStubs(), generatedSource, swiftStateRoundTripMain()].join('\n'),
      'utf8',
    );

    const compile = swiftcExecutable(programPath, binPath);
    expect(compile.status).toBe(0);

    const run = spawnSync(binPath, [], { cwd: workspace, encoding: 'utf8' });
    if (run.status !== 0) {
      throw new Error(
        `Swift state round-trip runtime gate failed (${run.status}):\n${run.stdout}\n${run.stderr}`,
      );
    }
    expect(run.status).toBe(0);
    expect(`${run.stdout}\n${run.stderr}`.trim()).toBe('');
  });

  it('typechecks CLI-03 Swift params collision with suffixed caller types', () => {
    const collisionFixture = readFileSync(path.join(fixturesDir, 'collision.fixture.ts'), 'utf8');
    const outDir = generateSwift({ 'collision.contract.ts': collisionFixture }, 'collision');
    const swiftFiles = generatedSwiftFiles(outDir);

    const dashFile = swiftFiles.find((fileName) => fileName.includes('CompileCollisionName'));
    expect(dashFile).toBeDefined();

    const source = readFileSync(dashFile as string, 'utf8');
    const suffixedParamsMatch = source.match(/struct (FooBarParams_[A-Za-z0-9_]+)/);
    expect(suffixedParamsMatch).not.toBeNull();
    const suffixedParams = suffixedParamsMatch?.[1] as string;
    expect(source).toContain(`func fooBar(_ params: ${suffixedParams}) async throws -> String`);
    expect(source).toContain(`decode${suffixedParams}(payload ?? [:])`);
    expect(source).toContain(`encode${suffixedParams}(params)`);

    const results = swiftFiles.map((swiftFile) => swiftcTypecheck(swiftFile));
    for (const result of results) {
      expect(result.status).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`.trim()).toBe('');
    }
  });

  it('typechecks CLI-04 Swift keyword and literal escaping fixture', () => {
    const keywordsFixture = readFileSync(path.join(fixturesDir, 'keywords.fixture.ts'), 'utf8');
    const outDir = generateSwift({ 'keywords.contract.ts': keywordsFixture }, 'keywords');
    const [swiftFile] = generatedSwiftFiles(outDir);
    expect(swiftFile).toBeDefined();

    const result = swiftcTypecheck(swiftFile as string);

    expect(result.status).toBe(0);
  });
});
