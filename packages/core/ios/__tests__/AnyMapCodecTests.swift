// AnyMapCodecTests.swift
// XCTest for AnyMapCodec — 7 round-trip / error scenarios.
// These tests require NitroModules (pod build only).

import XCTest
import NitroModules
@testable import BridgeKit

final class AnyMapCodecTests: XCTestCase {

    // Scenario 1: String value round-trips
    func test_toAnyMap_fromAnyMap_string_roundTrips() throws {
        let input: [String: Any?] = ["name": "hello"]
        let anyMap = try AnyMapCodec.toAnyMap(input)
        let output = AnyMapCodec.fromAnyMap(anyMap)

        XCTAssertEqual(output["name"] as? String, "hello")
    }

    // Scenario 2: Double/number value round-trips
    func test_toAnyMap_fromAnyMap_double_roundTrips() throws {
        let input: [String: Any?] = ["score": 3.14]
        let anyMap = try AnyMapCodec.toAnyMap(input)
        let output = AnyMapCodec.fromAnyMap(anyMap)

        XCTAssertEqual(output["score"] as? Double, 3.14, accuracy: 1e-10)
    }

    // Scenario 3: Bool value round-trips
    func test_toAnyMap_fromAnyMap_bool_roundTrips() throws {
        let input: [String: Any?] = ["flag": true]
        let anyMap = try AnyMapCodec.toAnyMap(input)
        let output = AnyMapCodec.fromAnyMap(anyMap)

        XCTAssertEqual(output["flag"] as? Bool, true)
    }

    // Scenario 4: Int64 value round-trips
    func test_toAnyMap_fromAnyMap_int64_roundTrips() throws {
        let value: Int64 = 9_007_199_254_740_993 // > Number.MAX_SAFE_INTEGER
        let input: [String: Any?] = ["id": value]
        let anyMap = try AnyMapCodec.toAnyMap(input)
        let output = AnyMapCodec.fromAnyMap(anyMap)

        XCTAssertEqual(output["id"] as? Int64, value)
    }

    // Scenario 5: Nested dictionary round-trips
    func test_toAnyMap_fromAnyMap_nestedDictionary_roundTrips() throws {
        let input: [String: Any?] = ["payload": ["x": 1.0, "y": 2.0]]
        let anyMap = try AnyMapCodec.toAnyMap(input)
        let output = AnyMapCodec.fromAnyMap(anyMap)

        let nested = output["payload"] as? [String: Any?]
        XCTAssertNotNil(nested)
        XCTAssertEqual(nested?["x"] as? Double, 1.0)
        XCTAssertEqual(nested?["y"] as? Double, 2.0)
    }

    // Scenario 6: Incompatible value THROWS
    // AnyMap.fromDictionary must throw on a non-AnyMap-compatible Swift type.
    func test_toAnyMap_incompatibleValue_throws() {
        // The specific error type is not part of the Nitro public API — assert that
        // any error is thrown. A custom struct makes a reliably incompatible value.
        struct NotAnyMapCompatible {}
        let input: [String: Any?] = ["bad": NotAnyMapCompatible()]
        XCTAssertThrowsError(try AnyMapCodec.toAnyMap(input)) { error in
            // Any error is acceptable — we just verify it throws.
            _ = error
        }
    }

    // Scenario 7: nil AnyMap input returns empty dictionary
    func test_fromAnyMap_nil_returnsEmpty() {
        let result = AnyMapCodec.fromAnyMap(nil)
        XCTAssertTrue(result.isEmpty)
    }
}
