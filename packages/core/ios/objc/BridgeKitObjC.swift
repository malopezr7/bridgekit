// BridgeKitObjC.swift
// Objective-C-safe facade for host app targets that must not import BridgeKit's
// Swift/C++ surface directly.

import Foundation

@objc(BKBridgeKitRuntime)
public final class BridgeKitObjC: NSObject {
    private static let streamLock = NSLock()
    private static var streamTasks: [String: Task<Void, Never>] = [:]

    @objc(configureDefault)
    public static func configureDefault() {
        _ = BridgeKitRuntime.default
    }

    @objc(dump)
    public static func dump() -> NSString {
        return BridgeKitRuntime.default.dump() as NSString
    }

    @objc(invokeContractWithContractId:scope:member:payload:completion:)
    public static func invokeContract(
        contractId: NSString,
        scope: NSString?,
        member: NSString,
        payload: NSDictionary?,
        completion: @escaping (Any?, NSString?) -> Void
    ) {
        let caller = makeCaller(contractId: contractId as String, scope: scope)
        let swiftPayload = decodePayload(payload)

        Task {
            do {
                let result = try await caller.invoke(member: member as String, payload: swiftPayload)
                finish(completion, encodeObjCValue(result), nil)
            } catch {
                finish(completion, nil, describe(error))
            }
        }
    }

    @objc(startStreamWithContractId:scope:member:payload:onValue:)
    public static func startStream(
        contractId: NSString,
        scope: NSString?,
        member: NSString,
        payload: NSDictionary?,
        onValue: @escaping (Any?, NSString?) -> Void
    ) -> NSString {
        let id = UUID().uuidString
        let caller = makeCaller(contractId: contractId as String, scope: scope)
        let swiftPayload = decodePayload(payload)

        let task = Task {
            do {
                let stream = caller.stream(member: member as String, payload: swiftPayload)
                for try await value in stream {
                    finish(onValue, encodeObjCValue(value), nil)
                }
            } catch {
                finish(onValue, nil, describe(error))
            }
            removeStream(id)
        }

        streamLock.lock()
        streamTasks[id] = task
        streamLock.unlock()

        return id as NSString
    }

    @objc(stopStreamWithId:)
    public static func stopStream(id: NSString) {
        streamLock.lock()
        let task = streamTasks.removeValue(forKey: id as String)
        streamLock.unlock()
        task?.cancel()
    }

    @objc(stopAllStreams)
    public static func stopAllStreams() {
        streamLock.lock()
        let tasks = Array(streamTasks.values)
        streamTasks.removeAll()
        streamLock.unlock()
        tasks.forEach { $0.cancel() }
    }

    private static func makeCaller(contractId: String, scope: NSString?) -> OutboundCallerImpl {
        let runtime = BridgeKitRuntime.default
        return OutboundCallerImpl(
            contractId: contractId,
            scope: Scope.deserialize((scope as String?) ?? Scope.global.serialized()),
            router: runtime.router,
            readinessTimeoutMs: runtime.router.readinessTimeoutMs,
            callTimeoutMs: runtime.router.callTimeoutMs
        )
    }

    private static func removeStream(_ id: String) {
        streamLock.lock()
        streamTasks.removeValue(forKey: id)
        streamLock.unlock()
    }

    private static func finish(
        _ block: @escaping (Any?, NSString?) -> Void,
        _ value: Any?,
        _ error: NSString?
    ) {
        if Thread.isMainThread {
            block(value, error)
        } else {
            DispatchQueue.main.async { block(value, error) }
        }
    }

    private static func describe(_ error: Error) -> NSString {
        return String(describing: error) as NSString
    }

    private static func decodePayload(_ payload: NSDictionary?) -> [String: Any?]? {
        guard let payload else { return nil }
        var result: [String: Any?] = [:]
        payload.forEach { key, value in
            guard let key = key as? String else { return }
            result[key] = decodeObjCValue(value)
        }
        return result
    }

    private static func decodeObjCValue(_ value: Any?) -> Any? {
        guard let value else { return nil }
        if value is NSNull { return nil }
        if let dictionary = value as? NSDictionary {
            var result: [String: Any?] = [:]
            dictionary.forEach { key, nested in
                guard let key = key as? String else { return }
                result[key] = decodeObjCValue(nested)
            }
            return result
        }
        if let array = value as? NSArray {
            return array.map { decodeObjCValue($0) ?? NSNull() }
        }
        return value
    }

    private static func encodeObjCValue(_ value: Any?) -> Any? {
        guard let value else { return nil }
        if let dictionary = value as? [String: Any?] {
            let result = NSMutableDictionary(capacity: dictionary.count)
            dictionary.forEach { key, nested in
                result[key] = encodeObjCValue(nested) ?? NSNull()
            }
            return result
        }
        if let array = value as? [Any?] {
            return array.map { encodeObjCValue($0) ?? NSNull() }
        }
        return value
    }
}
