#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^BKBridgeKitCompletion)(id _Nullable value, NSString * _Nullable errorMessage);
typedef void (^BKBridgeKitStreamValue)(id _Nullable value, NSString * _Nullable errorMessage);

/// Objective-C-safe facade over BridgeKit's Swift/Nitro runtime.
///
/// This header intentionally exposes only Foundation types so app targets can
/// call BridgeKit without importing the Swift module or enabling Swift C++
/// interoperability on the whole app target.
@interface BKBridgeKitRuntime : NSObject

+ (void)configureDefault NS_SWIFT_NAME(configureDefault());
+ (NSString *)dump NS_SWIFT_NAME(dump());

+ (void)invokeContractWithContractId:(NSString *)contractId
                               scope:(nullable NSString *)scope
                              member:(NSString *)member
                             payload:(nullable NSDictionary<NSString *, id> *)payload
                          completion:(BKBridgeKitCompletion)completion
    NS_SWIFT_NAME(invokeContract(contractId:scope:member:payload:completion:));

+ (NSString *)startStreamWithContractId:(NSString *)contractId
                                  scope:(nullable NSString *)scope
                                 member:(NSString *)member
                                payload:(nullable NSDictionary<NSString *, id> *)payload
                                onValue:(BKBridgeKitStreamValue)onValue
    NS_SWIFT_NAME(startStream(contractId:scope:member:payload:onValue:));

+ (void)stopStreamWithId:(NSString *)streamId NS_SWIFT_NAME(stopStream(id:));
+ (void)stopAllStreams NS_SWIFT_NAME(stopAllStreams());

@end

NS_ASSUME_NONNULL_END
