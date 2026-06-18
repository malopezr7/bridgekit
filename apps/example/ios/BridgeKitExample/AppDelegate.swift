import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    BridgeKitBootstrap.configureDemoRuntime()

    factory.startReactNative(
      withModuleName: "BridgeKitExample",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}


private enum BridgeKitBootstrap {
  static func configureDemoRuntime() {
    let selector = NSSelectorFromString("configure")
    let classNames = [
      "BridgeKitDemoSetup",
      "BridgeKitExampleDemo.BridgeKitDemoSetup",
    ]

    for className in classNames {
      guard let setupClass = NSClassFromString(className) as? NSObject.Type else {
        continue
      }

      guard setupClass.responds(to: selector) else {
        continue
      }

      setupClass.perform(selector)
      print("[BridgeKitExample] BridgeKit demo runtime configured via \(className)")
      return
    }

    print("[BridgeKitExample] BridgeKitDemoSetup not found; native demo contracts were not configured")
  }
}
