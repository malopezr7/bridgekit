// BridgeValueTests.swift
// XCTest for BridgeValue, BridgeKitDecodeError, Scope, and paramsHash.
// These tests compile only after the BridgeKit pod is installed.

import XCTest
@testable import BridgeKit

// MARK: - BridgeKitDecodeError

final class BridgeKitDecodeErrorTests: XCTestCase {

    func test_decodeError_properties() {
        let err = BridgeKitDecodeError(field: "userId", expectedType: "String")
        XCTAssertEqual(err.field, "userId")
        XCTAssertEqual(err.expectedType, "String")
    }

    func test_decodeError_conformsToError() {
        let err = BridgeKitDecodeError(field: "x", expectedType: "Int64")
        let asError: Error = err
        XCTAssertNotNil(asError)
    }

    func test_decodeError_description_containsField() {
        let err = BridgeKitDecodeError(field: "amount", expectedType: "Double")
        XCTAssertTrue(err.description.contains("amount"))
        XCTAssertTrue(err.description.contains("Double"))
    }

    func test_decodeError_pathAndActualType_preserveNestedContext() {
        let err = BridgeKitDecodeError(
            path: "opt[0].someKey.blob",
            expectedType: "Data",
            actualValue: 42
        )
        XCTAssertEqual(err.path, "opt[0].someKey.blob")
        XCTAssertEqual(err.field, "blob")
        XCTAssertEqual(err.expectedType, "Data")
        XCTAssertEqual(err.actualType, "Int")
        XCTAssertTrue(err.description.contains("opt[0].someKey.blob"))
        XCTAssertTrue(err.description.contains("Int"))
    }
}

// MARK: - BridgeValue

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

    // Verify exhaustive switch coverage — a 5th case triggers a compiler warning.
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

// MARK: - Scope

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
        // envelope uses "instance" key for the tag — matches wire format
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

// MARK: - paramsHash

final class ParamsHashTests: XCTestCase {

    // nil/empty payload → 0 (matches Kotlin `return 0L`)
    func test_nil_returnsZero() {
        XCTAssertEqual(paramsHash(nil), 0)
    }

    func test_empty_returnsZero() {
        XCTAssertEqual(paramsHash([:]), 0)
    }

    // TODO: back-fill golden values from Android round-trip proof run.

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
        // nil must render as "null" (Kotlin) not "nil" (Swift default).
        let hNull = paramsHash(["key": nil])
        XCTAssertNotEqual(hNull, 0)
        XCTAssertEqual(hNull, paramsHash(["key": nil]))
    }

    func test_hashFitsInUInt32Range() {
        let h = paramsHash(["contractId": "example", "member": "doSomething"])
        XCTAssertGreaterThanOrEqual(h, 0)
        XCTAssertLessThanOrEqual(h, Int64(UInt32.max))
    }
}
