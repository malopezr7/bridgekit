// AnyMapCodecTests.swift
// XCTest — RED-first for AnyMapCodec Domain-2 codec parity scenarios.
//
// Task 1.6: RED-first XCTest covering all 7 Domain-2 codec parity scenarios.
// These tests MUST fail (RED) until the pod compiles with NitroModules (L4).
// Do NOT add @available guards — let them fail on compile if the pod is absent.
//
// Domain-2 scenarios (7 total):
//   1. String value round-trips through toAnyMap/fromAnyMap
//   2. Double/number value round-trips
//   3. Bool value round-trips
//   4. Int64 value round-trips
//   5. Nested [String: Any?] (AnyMap-compatible object) round-trips
//   6. Incompatible value (e.g. a UIColor) THROWS from toAnyMap (INV-11)
//   7. nil AnyMap input returns empty dictionary (fromAnyMap nil guard)
//
// PORT NOTE: date↔Int64 epoch-ms and binary↔base64 are CODEGEN transforms,
// not raw AnyMapCodec transforms. The codegen layer (L5 emit/swift.ts) converts
// Date→Int64 and Data→String BEFORE calling toAnyMap. AnyMapCodec itself only
// sees primitives. Tests 1-6 cover the raw AnyMapCodec contract; codec-level
// date/binary transforms are tested in emit/swift.ts unit tests (L5).

import XCTest
import NitroModules
@testable import BridgeKit

final class AnyMapCodecTests: XCTestCase {

    // -------------------------------------------------------------------------
    // Scenario 1: String value round-trips
    // -------------------------------------------------------------------------
    func test_toAnyMap_fromAnyMap_string_roundTrips() throws {
        let input: [String: Any?] = ["name": "hello"]
        let anyMap = try AnyMapCodec.toAnyMap(input)
        let output = AnyMapCodec.fromAnyMap(anyMap)

        XCTAssertEqual(output["name"] as? String, "hello")
    }

    // -------------------------------------------------------------------------
    // Scenario 2: Double/number value round-trips
    // -------------------------------------------------------------------------
    func test_toAnyMap_fromAnyMap_double_roundTrips() throws {
        let input: [String: Any?] = ["score": 3.14]
        let anyMap = try AnyMapCodec.toAnyMap(input)
        let output = AnyMapCodec.fromAnyMap(anyMap)

        XCTAssertEqual(output["score"] as? Double, 3.14, accuracy: 1e-10)
    }

    // -------------------------------------------------------------------------
    // Scenario 3: Bool value round-trips
    // -------------------------------------------------------------------------
    func test_toAnyMap_fromAnyMap_bool_roundTrips() throws {
        let input: [String: Any?] = ["flag": true]
        let anyMap = try AnyMapCodec.toAnyMap(input)
        let output = AnyMapCodec.fromAnyMap(anyMap)

        XCTAssertEqual(output["flag"] as? Bool, true)
    }

    // -------------------------------------------------------------------------
    // Scenario 4: Int64 value round-trips
    // -------------------------------------------------------------------------
    func test_toAnyMap_fromAnyMap_int64_roundTrips() throws {
        let value: Int64 = 9_007_199_254_740_993 // > Number.MAX_SAFE_INTEGER
        let input: [String: Any?] = ["id": value]
        let anyMap = try AnyMapCodec.toAnyMap(input)
        let output = AnyMapCodec.fromAnyMap(anyMap)

        XCTAssertEqual(output["id"] as? Int64, value)
    }

    // -------------------------------------------------------------------------
    // Scenario 5: Nested dictionary round-trips
    // -------------------------------------------------------------------------
    func test_toAnyMap_fromAnyMap_nestedDictionary_roundTrips() throws {
        let input: [String: Any?] = ["payload": ["x": 1.0, "y": 2.0]]
        let anyMap = try AnyMapCodec.toAnyMap(input)
        let output = AnyMapCodec.fromAnyMap(anyMap)

        let nested = output["payload"] as? [String: Any?]
        XCTAssertNotNil(nested)
        XCTAssertEqual(nested?["x"] as? Double, 1.0)
        XCTAssertEqual(nested?["y"] as? Double, 2.0)
    }

    // -------------------------------------------------------------------------
    // Scenario 6: Incompatible value THROWS — INV-11
    // AnyMap.fromDictionary must throw on a non-AnyMap-compatible Swift type.
    // -------------------------------------------------------------------------
    func test_toAnyMap_incompatibleValue_throws() {
        // PORT NOTE: The specific error type thrown by AnyMap.fromDictionary for
        // incompatible values is not specified in the Nitro public API surface.
        // We assert that SOME error is thrown — sufficient to verify INV-11.
        // If NitroModules changes the throw semantics, this test catches the regression.
        //
        // Using a custom struct as the incompatible value (not a primitive/map/array).
        struct NotAnyMapCompatible {}
        let input: [String: Any?] = ["bad": NotAnyMapCompatible()]
        XCTAssertThrowsError(try AnyMapCodec.toAnyMap(input)) { error in
            // Any error is acceptable — we just verify it throws.
            _ = error
        }
    }

    // -------------------------------------------------------------------------
    // Scenario 7: nil AnyMap input returns empty dictionary
    // -------------------------------------------------------------------------
    func test_fromAnyMap_nil_returnsEmpty() {
        let result = AnyMapCodec.fromAnyMap(nil)
        XCTAssertTrue(result.isEmpty)
    }
}
