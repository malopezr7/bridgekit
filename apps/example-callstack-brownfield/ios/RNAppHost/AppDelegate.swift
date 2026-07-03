import UIKit

/// Thin placeholder AppDelegate for the RNAppHost shell target.
///
/// This target exists ONLY to give CocoaPods a concrete application target to
/// anchor use_native_modules! against (so BridgeKit + NitroModules autolinking
/// resolves). It is NOT intended to be run or shipped.
///
/// The real application is HostApp (separate project) which imports the
/// XCFrameworks produced by `pnpm package:ios`.

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    return true
  }
}
