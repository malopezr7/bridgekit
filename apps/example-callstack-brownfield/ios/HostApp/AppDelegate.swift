import ReactNativeFramework
import UIKit

/// Host app entry point.
///
/// Initialization order (CRITICAL):
///   1. BridgekitDemoInitializer.configure()  — registers native BridgeKit providers
///      BEFORE the JS bundle starts, so JS consumers find them on first resolve.
///      Mirrors apps/example/ios/BridgeKitExample/AppDelegate.swift line 16:
///        `BridgekitDemoInitializer.configure()`
///
///   2. ReactNativeBrownfield.shared.bundle = ReactNativeBundle
///      — points the brownfield runtime at the XCFramework bundle, not the host bundle.
///      Verified: Context7 /callstack/react-native-brownfield, "Initialize React Native in AppDelegate"
///
///   3. ReactNativeBrownfield.shared.startReactNative(onBundleLoaded:launchOptions:)
///      — starts the JS engine and loads the bundle asynchronously.
///      Verified: Context7 /callstack/react-native-brownfield, Swift API reference.
///
///   4. Native UINavigationController with HomeViewController as root — this is the
///      "existing native app" side; the RN screen is only presented on user action.

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Step 1: Register BridgeKit native providers BEFORE JS bundle loads.
    // BridgekitDemoInitializer lives in ReactNativeFramework (not HostApp) because
    // BridgeKit pod is linked into the framework target, not the host.
    BridgekitDemoInitializer.configure()

    // Step 2 + 3: Wire brownfield runtime and start RN.
    ReactNativeBrownfield.shared.bundle = ReactNativeBundle
    ReactNativeBrownfield.shared.startReactNative(
      onBundleLoaded: {
        NSLog("[HostApp] React Native bundle loaded")
      },
      launchOptions: launchOptions
    )

    // Step 4: Native home screen is the root — RN is presented on demand.
    window = UIWindow(frame: UIScreen.main.bounds)
    let nav = UINavigationController(rootViewController: HomeViewController())
    window?.rootViewController = nav
    window?.makeKeyAndVisible()

    return true
  }
}
