// swift-tools-version: 5.9

// TEST-ONLY MANIFEST. This is not how BridgeKit is distributed.
//
// Consumers get BridgeKit through CocoaPods (BridgeKit.podspec, resolved by React
// Native autolinking). This manifest exists so the iOS engine can be unit-tested
// at all: before it, packages/core/ios had zero executing tests, no test target
// and no CI job, and two blocking compile errors sat on main for 23 days.
//
// It works because the engine is pure Swift and Foundation-only. The four files
// that import NitroModules — ios/nitro/* and runtime/AnyMapCodec.swift — are
// excluded, because SPM cannot compile Swift and C-family sources in one target
// and Nitro itself ships no SPM manifest. Those are covered by the xcframework
// archive in .github/workflows/ios-facade.yml.
//
// Nothing here depends on UIKit, so `swift test` runs natively on the host with
// no simulator boot. That is the whole point: iOS test feedback in seconds.

import PackageDescription

let package = Package(
    name: "BridgeKit",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [
        .library(name: "BridgeKit", targets: ["BridgeKit"])
    ],
    targets: [
        .target(
            name: "BridgeKit",
            path: "ios",
            exclude: [
                "__tests__",
                // Requires NitroModules; see the note above.
                "nitro",
                "runtime/AnyMapCodec.swift",
                // A stray header would make this a mixed-language target.
                "objc/BridgeKitObjC.h"
            ]
        ),
        .testTarget(
            name: "BridgeKitTests",
            dependencies: ["BridgeKit"],
            path: "ios/__tests__",
            exclude: [
                // Imports NitroModules; runs only in the pod/xcframework build.
                "AnyMapCodecTests.swift"
            ]
        )
    ]
)
