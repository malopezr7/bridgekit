// Public interface for the ReactNativeFramework XCFramework target.
//
// This file does two things required by @callstack/react-native-brownfield:
//
//   1. Re-exports ReactBrownfield so the host app can import everything from
//      this single framework (verified: Context7 /callstack/react-native-brownfield,
//      "Create Framework Public Interface", docs/getting-started/ios.mdx).
//
//   2. Exposes ReactNativeBundle — a Bundle that resolves relative to this
//      framework binary, not the host app — so that the embedded JS bundle and
//      assets are found correctly at runtime.
//
// The host app does:
//   import ReactNativeFramework
//   ReactNativeBrownfield.shared.bundle = ReactNativeBundle
//
// Source: https://github.com/callstack/react-native-brownfield docs/getting-started/ios.mdx

// Export helpers from @callstack/react-native-brownfield library.
@_exported import ReactBrownfield

// Initializes a Bundle instance that points at the framework target.
// Using Bundle(for:) with a class defined in this module ensures
// the bundle resolves to the XCFramework, not the host app bundle.
public let ReactNativeBundle = Bundle(for: InternalClassForBundle.self)

// Internal anchor class — never instantiated directly.
class InternalClassForBundle {}
