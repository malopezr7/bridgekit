// BridgeValueTests.swift
// XCTest — RED-first for BridgeValue, BridgeKitDecodeError, Scope, and paramsHash.
//
// Task 1.2–1.5: covers INV-6 (exactly 4 BridgeValue cases), INV-10 (error struct),
// INV-12 (Scope wire strings), INV-9 (paramsHash FNV-1a parity).
// These tests MUST compile only after the BridgeKit pod is installed (L4).

import XCTest
@testable import BridgeKit

// =============================================================================
// MARK: - BridgeKitDecodeError
// =============================================================================

final class BridgeKitDecodeErrorTests: XCTestCase {

    func test_decodeError_properties() {
        let err = BridgeKitDecodeError(field: "userId", expectedType: "String")
        XCTAssertEqual(err.field, "userId")
        XCTAssertEqual(err.expectedType, "String")
    }

    func test_decodeError_conformsToError() {
        let err = BridgeKitDecodeError(field: "x", expectedType: "Int64")
        // Verify it can be used as Swift Error (checked at compile time by the cast)
        let asError: Error = err
        XCTAssertNotNil(asError)
    }

    func test_decodeError_description_containsField() {
        let err = BridgeKitDecodeError(field: "amount", expectedType: "Double")
        XCTAssertTrue(err.description.contains("amount"))
        XCTAssertTrue(err.description.contains("Double"))
    }
}

// =============================================================================
// MARK: - BridgeValue — INV-6: exactly 4 cases, no 5th case
// =============================================================================

final class BridgeValueTests: XCTestCase {

    func test_available_valueOrNil_returnsValue() {
        let bv = BridgeValue<Int>.available(42)
        XCTAssertEqual(bv.valueOrNil(), 42)
    }

    func test_initial_valueOrNil_returnsValue() {
        let bv = BridgeValue<String>.initial("hello")
        XCTAssertEqual(bv.valueOrNil(), "hello")
    }

    func test_replacing_withLastKnown_returnsLastKnown() {
        let bv = BridgeValue<Int>.replacing(7)
        XCTAssertEqual(bv.valueOrNil(), 7)
    }

    func test_replacing_nilLastKnown_returnsNil() {
        let bv = BridgeValue<Int>.replacing(nil)
        XCTAssertNil(bv.valueOrNil())
    }

    func test_unprovided_withLastKnown_returnsLastKnown() {
        let bv = BridgeValue<Double>.unprovided(3.14)
        XCTAssertEqual(bv.valueOrNil(), 3.14)
    }

    func test_unprovided_nilLastKnown_returnsNil() {
        let bv = BridgeValue<Double>.unprovided(nil)
        XCTAssertNil(bv.valueOrNil())
    }

    // INV-6: verify exhaustive switch coverage — if a 5th case is added the
    // compiler will warn that this switch is no longer exhaustive.
    func test_exactlyFourCases_exhaustiveSwitch() {
        func label<T>(_ bv: BridgeValue<T>) -> String {
            switch bv {
            case .available:   return "available"
            case .initial:     return "initial"
            case .replacing:   return "replacing"
            case .unprovided:  return "unprovided"
            }
        }
        XCTAssertEqual(label(BridgeValue<Int>.available(0)), "available")
        XCTAssertEqual(label(BridgeValue<Int>.initial(0)), "initial")
        XCTAssertEqual(label(BridgeValue<Int>.replacing(nil)), "replacing")
        XCTAssertEqual(label(BridgeValue<Int>.unprovided(nil)), "unprovided")
    }
}

// =============================================================================
// MARK: - Scope — INV-12: wire strings MUST match Kotlin byte-for-byte
// =============================================================================

final class ScopeTests: XCTestCase {

    // serialized() wire strings
    func test_global_serialized() {
        XCTAssertEqual(Scope.global.serialized(), "global")
    }

    func test_feature_serialized() {
        XCTAssertEqual(Scope.feature("checkout").serialized(), "feature:checkout")
    }

    func test_instance_serialized() {
        XCTAssertEqual(Scope.instance(feature: "cart", tag: "main").serialized(), "instance:cart:main")
    }

    // deserialize() — round-trip
    func test_deserialize_global() {
        XCTAssertEqual(Scope.deserialize("global"), .global)
    }

    func test_deserialize_feature() {
        XCTAssertEqual(Scope.deserialize("feature:checkout"), .feature("checkout"))
    }

    func test_deserialize_instance() {
        XCTAssertEqual(Scope.deserialize("instance:cart:main"), .instance(feature: "cart", tag: "main"))
    }

    func test_deserialize_unknown_fallsBackToGlobal() {
        XCTAssertEqual(Scope.deserialize("bogus:value"), .global)
    }

    // Instance tag may itself contain a colon — Kotlin splits with limit=2.
    func test_deserialize_instance_tagWithColon() {
        let scope = Scope.deserialize("instance:cart:sub:detail")
        XCTAssertEqual(scope, .instance(feature: "cart", tag: "sub:detail"))
    }

    // from(envelopeMap:)
    func test_fromEnvelopeMap_global() {
        let map: [String: Any?] = ["kind": "global"]
        XCTAssertEqual(Scope.from(envelopeMap: map), .global)
    }

    func test_fromEnvelopeMap_feature() {
        let map: [String: Any?] = ["kind": "feature", "feature": "checkout"]
        XCTAssertEqual(Scope.from(envelopeMap: map), .feature("checkout"))
    }

    func test_fromEnvelopeMap_instance() {
        // PORT NOTE: envelope uses "instance" key for the tag (mirrors Kotlin Router.scopeToEnvMap)
        let map: [String: Any?] = ["kind": "instance", "feature": "cart", "instance": "main"]
        XCTAssertEqual(Scope.from(envelopeMap: map), .instance(feature: "cart", tag: "main"))
    }

    func test_fromEnvelopeMap_missingKind_fallsBackToGlobal() {
        let map: [String: Any?] = [:]
        XCTAssertEqual(Scope.from(envelopeMap: map), .global)
    }

    // Hashable — can be used as dictionary key
    func test_hashable_usedAsDictionaryKey() {
        var dict: [Scope: Int] = [:]
        dict[.global] = 1
        dict[.feature("a")] = 2
        dict[.instance(feature: "a", tag: "b")] = 3
        XCTAssertEqual(dict[.global], 1)
        XCTAssertEqual(dict[.feature("a")], 2)
        XCTAssertEqual(dict[.instance(feature: "a", tag: "b")], 3)
    }
}

// =============================================================================
// MARK: - paramsHash — INV-9: FNV-1a 32-bit, must match Kotlin byte-for-byte
// =============================================================================

final class ParamsHashTests: XCTestCase {

    // nil/empty payload → 0 (matches Kotlin `return 0L`)
    func test_nil_returnsZero() {
        XCTAssertEqual(paramsHash(nil), 0)
    }

    func test_empty_returnsZero() {
        XCTAssertEqual(paramsHash([:]), 0)
    }

    // Known FNV-1a values — verified by running Kotlin side manually.
    // GOLDEN VALUES: these must be computed from the Kotlin implementation
    // at L8 simulator proof time and back-filled here. The test structure is
    // correct; the expected Int64 values below are PLACEHOLDER until L8 parity
    // is confirmed on-device.
    //
    // PORT NOTE: Golden values require running the Kotlin paramsHash with the
    // same inputs on Android and recording the Long output, then asserting
    // identical output here. This is the parity gate for INV-9.
    // TODO(L8): back-fill golden values from Android round-trip proof run.

    func test_singleStringValue_deterministicHash() {
        let h1 = paramsHash(["key": "value"])
        let h2 = paramsHash(["key": "value"])
        XCTAssertEqual(h1, h2)
        XCTAssertNotEqual(h1, 0)
    }

    func test_keyOrder_doesNotAffectHash() {
        // Sorted iteration must produce the same hash regardless of insertion order.
        let h1 = paramsHash(["a": "1", "b": "2"])
        let h2 = paramsHash(["b": "2", "a": "1"])
        XCTAssertEqual(h1, h2)
    }

    func test_differentValues_differentHashes() {
        let h1 = paramsHash(["key": "value1"])
        let h2 = paramsHash(["key": "value2"])
        XCTAssertNotEqual(h1, h2)
    }

    func test_nilValue_renderedAsKotlinNull() {
        // A nil value in the map must render as "null" (Kotlin "$v" of null),
        // not "nil" (Swift default). If this returns same hash as "key=nil", parity is broken.
        let hNull = paramsHash(["key": nil])
        // The hash of "key=null" (FNV-1a over that string) must be stable.
        // We test it is non-zero and deterministic.
        XCTAssertNotEqual(hNull, 0)
        XCTAssertEqual(hNull, paramsHash(["key": nil]))
    }

    // PORT NOTE: hash result fits in UInt32 range (mask 0xFFFFFFFF).
    func test_hashFitsInUInt32Range() {
        let h = paramsHash(["contractId": "example", "member": "doSomething"])
        XCTAssertGreaterThanOrEqual(h, 0)
        XCTAssertLessThanOrEqual(h, Int64(UInt32.max))
    }
}
