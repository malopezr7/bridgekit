import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  private let factory = ReactNativeFactory()

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)

    // Initialize BridgeKit before JS loads (mirrors Android's MainApplication.onCreate).
    BridgekitDemoInitializer.configure()

    factory.startReactNative(
      withModuleName: "BridgeKitExample",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}
