#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Wraps RCTReactNativeFactory + its Expo-aware delegate.
 *
 * Call -rootViewForModuleName: to obtain a React Native root view that can be
 * embedded inside any native UIViewController.  The factory keeps the JS engine
 * alive for the lifetime of the host process, so a single shared instance is
 * enough.
 */
@interface ReactNativeFactory : NSObject

/**
 * Returns the React Native root view for the given module name.
 * Safe to call multiple times; the underlying JSC/Hermes VM is shared.
 */
- (UIView *)rootViewForModuleName:(NSString *)moduleName;

@end

NS_ASSUME_NONNULL_END
