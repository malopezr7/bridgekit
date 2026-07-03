import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  /// Shared factory — holds the JS engine alive for the process lifetime.
  /// MUST be initialised before any RN root view is requested.
  let rnFactory = ReactNativeFactory()

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)

    // Initialize BridgeKit BEFORE the JS bundle loads.
    // Mirrors exactly what apps/example/ios/BridgeKitExample/AppDelegate.swift does:
    //   BridgeKitDemoSupportConfigure()
    BridgeKitDemoSupportConfigure()

    // Native home screen is the entry point — not a React Native view.
    let nav = UINavigationController(rootViewController: HomeViewController())
    window?.rootViewController = nav
    window?.makeKeyAndVisible()

    return true
  }
}
