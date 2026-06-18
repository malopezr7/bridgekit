import BridgeKit
import Foundation

private let bridgeKitDemoTag = "BridgeKitDemo"
private let bridgeKitReverseTag = "BridgeKitReverse"
private let bridgeKitJsInfoTag = "BridgeKitJsInfo"

private func bridgeKitDemoLog(_ message: String) {
  NSLog("%@", message)
}

enum BridgekitDemoInitializer {
  static func configure() {
    let bridgeKit = BridgeKitRuntime.default

    _ = bridgeKit.provide(BridgekitDemoHostContract(), scope: .global) {
      DemoHostImpl()
    }
    bridgeKitDemoLog("[\(bridgeKitDemoTag)] DemoHost provided at global scope")

    Task {
      try? await Task.sleep(nanoseconds: 15_000_000_000)
      do {
        let feature = bridgeKit.consume(BridgekitDemoFeatureContract(), scope: .global)
        let result = try await feature.getGreeting(GetGreetingParams(name: "BridgeKit"))
        bridgeKitDemoLog("[\(bridgeKitDemoTag)] JS greeting=\(result)")
      } catch {
        bridgeKitDemoLog("[\(bridgeKitDemoTag)] native-to-JS feature consume failed: \(error)")
      }
    }

    Task {
      do {
        let reverse = bridgeKit.consume(BridgekitDemoReverseContract(), scope: .global)
        let deadline = Date().addingTimeInterval(90)
        var asyncOk = false

        while !asyncOk && Date() < deadline {
          do {
            let greeting = try await reverse.greetFromJs(GreetFromJsParams(name: "iOS"))
            bridgeKitDemoLog("[\(bridgeKitReverseTag)] async=\(greeting)")
            asyncOk = true
          } catch {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
          }
        }

        if !asyncOk {
          bridgeKitDemoLog("[\(bridgeKitReverseTag)] async never became ready within 90s")
        }

        reverse.onNativeEvent(OnNativeEventParams(type: "native-tap", payload: "button_a"))
        bridgeKitDemoLog("[\(bridgeKitReverseTag)] void fired type=native-tap")

        Task {
          var count = 0
          for await value in reverse.jsCounter() {
            bridgeKitDemoLog("[\(bridgeKitReverseTag)] stream tick=\(value)")
            count += 1
            if count >= 5 { break }
          }
        }

        Task {
          for await value in reverse.jsStatus {
            switch value {
            case .available(let status):
              bridgeKitDemoLog("[\(bridgeKitReverseTag)] state=\(status)")
            case .initial(let status):
              bridgeKitDemoLog("[\(bridgeKitReverseTag)] state=initial(\(status))")
            case .replacing(let last):
              bridgeKitDemoLog("[\(bridgeKitReverseTag)] state=replacing(\(String(describing: last)))")
            case .unprovided(let last):
              bridgeKitDemoLog("[\(bridgeKitReverseTag)] state=unprovided(\(String(describing: last)))")
            }
          }
        }
      } catch {
        bridgeKitDemoLog("[\(bridgeKitReverseTag)] reverse consume failed: \(error)")
      }
    }

    Task {
      let jsInfo = bridgeKit.consume(BridgekitDemoJsinfoContract(), scope: .global)
      let deadline = Date().addingTimeInterval(90)
      var ready = false

      while !ready && Date() < deadline {
        do {
          let version = try await jsInfo.getReactNativeVersion()
          let level = try await jsInfo.getUserLevel()
          let segments = try await jsInfo.getUserSegments()
          bridgeKitDemoLog(
            "[\(bridgeKitJsInfoTag)] rnVersion=\(version) userLevel=L\(Int(level.level)) \(level.label) segments=\(segments.joined(separator: ","))"
          )
          ready = true
        } catch {
          try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
      }

      if !ready {
        bridgeKitDemoLog("[\(bridgeKitJsInfoTag)] getReactNativeVersion never became ready within 90s")
      }

      Task {
        var count = 0
        for await value in jsInfo.clockTicks() {
          bridgeKitDemoLog("[\(bridgeKitJsInfoTag)] clock tick=\(value)")
          count += 1
          if count >= 5 { break }
        }
      }
    }

    bridgeKitDemoLog("[\(bridgeKitDemoTag)] BridgeKit initialized. dump=\(bridgeKit.dump())")
  }
}

private final class DemoHostImpl: BridgekitDemoHost {
  private var counterValue: Double = 0
  private let counterLock = NSLock()
  private var counterContinuations: [UUID: AsyncStream<Double>.Continuation] = [:]
  private let counterContinuationLock = NSLock()

  private var echoContinuations: [UUID: AsyncStream<String>.Continuation] = [:]
  private let echoLock = NSLock()

  func ping(_ params: PingParams) async throws -> PingResult {
    PingResult(
      reply: "pong: \(params.message)",
      epoch: Double(Date().timeIntervalSince1970 * 1000)
    )
  }

  func increment() async throws -> Double {
    counterLock.lock()
    counterValue += 1
    let next = counterValue
    counterLock.unlock()

    pushCounter(next)
    return next
  }

  func say(_ params: SayParams) {
    let echoed = params.text.uppercased()
    bridgeKitDemoLog("[\(bridgeKitDemoTag)] DemoHostImpl.say: \(params.text) -> \(echoed)")
    echoText(echoed)
  }

  func ticker() -> AsyncStream<Double> {
    AsyncStream { continuation in
      let task = Task {
        var tick: Double = 0
        while !Task.isCancelled {
          try? await Task.sleep(nanoseconds: 1_000_000_000)
          tick += 1
          continuation.yield(tick)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  func echoes() -> AsyncStream<String> {
    AsyncStream { continuation in
      let id = UUID()
      echoLock.lock()
      echoContinuations[id] = continuation
      echoLock.unlock()

      continuation.onTermination = { [weak self] _ in
        guard let self else { return }
        self.echoLock.lock()
        self.echoContinuations.removeValue(forKey: id)
        self.echoLock.unlock()
      }
    }
  }

  var counter: AsyncStream<Double> {
    AsyncStream { continuation in
      let id = UUID()

      counterLock.lock()
      let current = counterValue
      counterLock.unlock()
      continuation.yield(current)

      counterContinuationLock.lock()
      counterContinuations[id] = continuation
      counterContinuationLock.unlock()

      continuation.onTermination = { [weak self] _ in
        guard let self else { return }
        self.counterContinuationLock.lock()
        self.counterContinuations.removeValue(forKey: id)
        self.counterContinuationLock.unlock()
      }
    }
  }

  private func pushCounter(_ value: Double) {
    counterContinuationLock.lock()
    let continuations = Array(counterContinuations.values)
    counterContinuationLock.unlock()

    for continuation in continuations {
      continuation.yield(value)
    }
  }

  private func echoText(_ text: String) {
    echoLock.lock()
    let continuations = Array(echoContinuations.values)
    echoLock.unlock()

    for continuation in continuations {
      continuation.yield(text)
    }
  }
}
