# BridgeKit.xcframework build

Build the standalone iOS binary artifact from `packages/core`:

```sh
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
./scripts/build-ios-xcframework.sh
```

Output:

```text
packages/core/build/ios-xcframework/BridgeKit.xcframework
```

The build archives `iphoneos` and `iphonesimulator` slices with
`BUILD_LIBRARY_FOR_DISTRIBUTION=YES` and `SWIFT_OBJC_INTEROP_MODE=objcxx` inside
BridgeKit only. The public `BridgeKit.swiftinterface` is verified not to expose
Nitro/C++ symbols.
