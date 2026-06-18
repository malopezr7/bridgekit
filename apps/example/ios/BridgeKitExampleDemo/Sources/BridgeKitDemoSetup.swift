import BridgeKit
import Foundation

@objc(BridgeKitDemoSetup)
public final class BridgeKitDemoSetup: NSObject {
  @objc public static func configure() {
    BridgekitDemoInitializer.configure()
  }

  private static let jsInfo: any BridgekitDemoJsinfoClient =
    BridgeKitRuntime.default.consume(BridgekitDemoJsinfoContract(), scope: .global)

  private static var clockTask: Task<Void, Never>?

  @objc public static func fetchReactNativeVersion(_ completion: @escaping (NSString?, NSString?) -> Void) {
    Task {
      do {
        let value = try await jsInfo.getReactNativeVersion()
        finish(completion, value as NSString, nil)
      } catch {
        finish(completion, nil, describe(error))
      }
    }
  }

  @objc public static func fetchUserLevel(_ completion: @escaping (NSString?, NSString?) -> Void) {
    Task {
      do {
        let level = try await jsInfo.getUserLevel()
        let text = "L\(Int(level.level)) · \(level.label)"
        finish(completion, text as NSString, nil)
      } catch {
        finish(completion, nil, describe(error))
      }
    }
  }

  @objc public static func fetchUserSegments(_ completion: @escaping (NSString?, NSString?) -> Void) {
    Task {
      do {
        let segments = try await jsInfo.getUserSegments()
        let text = segments.isEmpty ? "(none)" : segments.joined(separator: ", ")
        finish(completion, text as NSString, nil)
      } catch {
        finish(completion, nil, describe(error))
      }
    }
  }

  @objc public static func startClock(_ onTick: @escaping (NSString?, NSString?) -> Void) {
    clockTask?.cancel()
    clockTask = Task {
      for await tick in jsInfo.clockTicks() {
        finish(onTick, "\(Int(tick))" as NSString, nil)
      }
    }
  }

  @objc public static func stopClock() {
    clockTask?.cancel()
    clockTask = nil
  }

  private static func finish(
    _ block: @escaping (NSString?, NSString?) -> Void,
    _ value: NSString?,
    _ error: NSString?
  ) {
    if Thread.isMainThread {
      block(value, error)
    } else {
      DispatchQueue.main.async { block(value, error) }
    }
  }

  private static func describe(_ error: Error) -> NSString {
    error.localizedDescription as NSString
  }
}
