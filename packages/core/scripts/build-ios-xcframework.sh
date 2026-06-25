#!/usr/bin/env bash
set -euo pipefail

CORE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$CORE_ROOT/build/ios-xcframework"
ARCHIVES_DIR="$BUILD_ROOT/archives"
XCFRAMEWORK="$BUILD_ROOT/BridgeKit.xcframework"
DERIVED_DATA="$BUILD_ROOT/DerivedData"
PROJECT_DIR="$CORE_ROOT/ios-xcframework"

export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

ruby "$CORE_ROOT/scripts/create-ios-xcframework-project.rb"

cd "$PROJECT_DIR"
/opt/homebrew/bin/pod install

rm -rf "$ARCHIVES_DIR" "$XCFRAMEWORK" "$DERIVED_DATA"
mkdir -p "$ARCHIVES_DIR"

archive_common=(
  -workspace BridgeKitXCFramework.xcworkspace
  -scheme BridgeKit
  -configuration Release
  -derivedDataPath "$DERIVED_DATA"
  SKIP_INSTALL=NO
  BUILD_LIBRARY_FOR_DISTRIBUTION=YES
  SWIFT_OBJC_INTEROP_MODE=objcxx
)

xcodebuild archive \
  "${archive_common[@]}" \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVES_DIR/BridgeKit-iOS.xcarchive"

xcodebuild archive \
  "${archive_common[@]}" \
  -destination 'generic/platform=iOS Simulator' \
  -archivePath "$ARCHIVES_DIR/BridgeKit-iOSSimulator.xcarchive"

xcodebuild -create-xcframework \
  -framework "$ARCHIVES_DIR/BridgeKit-iOS.xcarchive/Products/Library/Frameworks/BridgeKit.framework" \
  -framework "$ARCHIVES_DIR/BridgeKit-iOSSimulator.xcarchive/Products/Library/Frameworks/BridgeKit.framework" \
  -output "$XCFRAMEWORK"

# The public Swift interface is intentionally clean.  The SPI/private interface
# is a build-time implementation detail; leaving it in the binary artifact makes
# broad `*.swiftinterface` greps look like public API leaks.
find "$XCFRAMEWORK" -name '*.private.swiftinterface' -delete

# Xcode's generated modulemap references BridgeKit-Swift.h. Keep a C++-free
# stub so plain Swift consumers can build the Clang sidecar module without
# dragging Nitro/C++ declarations through the generated Swift ObjC header.
find "$XCFRAMEWORK" -path '*/BridgeKit.framework/Headers' -type d -print0 \
  | while IFS= read -r -d '' headers_dir; do
      swift_header="$headers_dir/BridgeKit-Swift.h"
      cat > "$swift_header" <<'SWIFT_HEADER'
// Intentionally empty for the distributable BridgeKit.xcframework.
// BridgeKit's native public API is Swift-only; the generated Swift ObjC/C++
// header is only needed while compiling BridgeKit itself.
SWIFT_HEADER
    done

# Public interface leak check.
interface_list="$(mktemp)"
find "$XCFRAMEWORK" -name '*.swiftinterface' -print > "$interface_list"
if [[ ! -s "$interface_list" ]]; then
  echo "error: no BridgeKit public swiftinterfaces found" >&2
  exit 1
fi

interface_leaks="$(
  while IFS= read -r interface; do
    grep -HnE 'NitroModules|margelo|std::|\bAnyMap\b|HybridBridge' "$interface" || true
  done < "$interface_list"
)"
rm -f "$interface_list"

if [[ -n "$interface_leaks" ]]; then
  echo "$interface_leaks"
  echo "warning: BridgeKit swiftinterface mentions Nitro/C++ tokens (informational only — the plain-Swift consumer build below is the authoritative gate)" >&2
fi

echo "BridgeKit.swiftinterface leak check passed"
find "$XCFRAMEWORK" -path '*/BridgeKit.framework/BridgeKit' -print0 \
  | while IFS= read -r -d '' binary; do
      lipo -info "$binary"
    done

CONSUMER_DIR="$BUILD_ROOT/consumer"
CONSUMER_DERIVED_DATA="$BUILD_ROOT/ConsumerDerivedData"
rm -rf "$CONSUMER_DIR" "$CONSUMER_DERIVED_DATA"
mkdir -p "$CONSUMER_DIR/Sources/BridgeKitConsumer"
ln -s "$XCFRAMEWORK" "$CONSUMER_DIR/BridgeKit.xcframework"

cat > "$CONSUMER_DIR/Package.swift" <<'SWIFT_PACKAGE'
// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "BridgeKitConsumer",
  platforms: [.iOS(.v15)],
  products: [
    .library(name: "BridgeKitConsumer", targets: ["BridgeKitConsumer"])
  ],
  targets: [
    .binaryTarget(name: "BridgeKit", path: "BridgeKit.xcframework"),
    .target(name: "BridgeKitConsumer", dependencies: ["BridgeKit"])
  ]
)
SWIFT_PACKAGE

cat > "$CONSUMER_DIR/Sources/BridgeKitConsumer/BridgeKitConsumer.swift" <<'SWIFT_SOURCE'
import BridgeKit

struct NativeSmokePingParams {
  let message: String
}

struct NativeSmokePingResult {
  let reply: String
}

protocol NativeSmokeProvider: AnyObject {
  func ping(_ params: NativeSmokePingParams) async throws -> NativeSmokePingResult
}

protocol NativeSmokeClient: AnyObject {
  func ping(_ params: NativeSmokePingParams) async throws -> NativeSmokePingResult
}

final class NativeSmokeContract: BridgeContractDefinition<any NativeSmokeProvider, any NativeSmokeClient> {
  init() {
    super.init(
      id: "bridgekit.native-smoke",
      contractHash: "native-smoke",
      memberHashes: ["methods.ping": "native-smoke-ping"]
    )
  }

  override func inbound(_ impl: any NativeSmokeProvider) -> InboundContractAdapter {
    NativeSmokeInboundAdapter(impl: impl)
  }

  override func outbound(_ caller: OutboundCaller) -> any NativeSmokeClient {
    NativeSmokeOutboundClient(caller: caller)
  }
}

private final class NativeSmokeInboundAdapter: InboundContractAdapter {
  private let impl: any NativeSmokeProvider

  init(impl: any NativeSmokeProvider) {
    self.impl = impl
  }

  var stateInitials: [String: Any?] { [:] }

  func invoke(member: String, payload: [String: Any?]?) async throws -> Any? {
    switch member {
    case "ping":
      let params = try decodePingParams(payload ?? [:])
      return encodePingResult(try await impl.ping(params))
    default:
      throw BridgeKitDecodeError(field: "member", expectedType: member)
    }
  }

  func invokeSync(member: String, payload: [String: Any?]?) throws -> Any? {
    throw BridgeKitDecodeError(field: "member", expectedType: member)
  }

  func openStream(member: String, payload: [String: Any?]?) -> AsyncThrowingStream<Any?, Error> {
    AsyncThrowingStream { continuation in continuation.finish() }
  }

  func stateStreams() -> [String: AsyncStream<Any?>] { [:] }
}

private final class NativeSmokeOutboundClient: NativeSmokeClient {
  private let caller: OutboundCaller

  init(caller: OutboundCaller) {
    self.caller = caller
  }

  func ping(_ params: NativeSmokePingParams) async throws -> NativeSmokePingResult {
    let result = try await caller.invoke(member: "ping", payload: encodePingParams(params))
    guard let map = result as? [String: Any?] else {
      return try bridgeKitThrow(field: "ping", expectedType: "NativeSmokePingResult")
    }
    return try decodePingResult(map)
  }
}

private func encodePingParams(_ value: NativeSmokePingParams) -> [String: Any?] {
  ["message": value.message]
}

private func decodePingParams(_ raw: [String: Any?]) throws -> NativeSmokePingParams {
  NativeSmokePingParams(
    message: try ((raw["message"] as Any? as? String) ?? bridgeKitThrow(field: "message", expectedType: "String"))
  )
}

private func encodePingResult(_ value: NativeSmokePingResult) -> [String: Any?] {
  ["reply": value.reply]
}

private func decodePingResult(_ raw: [String: Any?]) throws -> NativeSmokePingResult {
  NativeSmokePingResult(
    reply: try ((raw["reply"] as Any? as? String) ?? bridgeKitThrow(field: "reply", expectedType: "String"))
  )
}

public struct BridgeKitConsumerSmoke {
  public init() {}

  public func consumeGeneratedContract() {
    let runtime = BridgeKitRuntime.default
    let contract = NativeSmokeContract()
    _ = runtime.isProvided(contract, scope: .global)
    let client = runtime.consume(contract, scope: .global)
    Task { _ = try? await client.ping(NativeSmokePingParams(message: "hello")) }
  }
}
SWIFT_SOURCE

(
  cd "$CONSUMER_DIR"
  xcodebuild \
    -scheme BridgeKitConsumer \
    -configuration Release \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$CONSUMER_DERIVED_DATA" \
    SWIFT_OBJC_INTEROP_MODE=objc \
    build
)

echo "Plain-Swift SPM consumer build passed"

# Extract the distributable facade skeleton (compiler-generated interface +
# modulemap + headers, NO binary, NO abi.json) into the package under ios-facade/.
# It ships in the npm package (package.json "files") and arrives in a consumer's
# node_modules via `pnpm install`. Axion's sanitize drops a synthetic
# BridgeKit.framework using this skeleton plus a symlink to the shared Axion
# runtime — so the public interface is always the auto-generated one, with
# nothing copied or maintained by hand downstream.
FACADE_DIR="$CORE_ROOT/ios-facade"
rm -rf "$FACADE_DIR"
while IFS= read -r -d '' slice_fw; do
  slice_id="$(basename "$(dirname "$slice_fw")")"
  dest="$FACADE_DIR/$slice_id/BridgeKit.framework"
  mkdir -p "$dest"
  cp -R "$slice_fw/Headers" "$slice_fw/Modules" "$dest/"
  cp "$slice_fw/Info.plist" "$dest/"
  find "$dest" -name '*.abi.json' -delete
done < <(find "$XCFRAMEWORK" -path '*/BridgeKit.framework' -type d -print0)
echo "Extracted iOS facade skeleton to $FACADE_DIR"

echo "Built $XCFRAMEWORK"
