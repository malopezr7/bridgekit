#import "ReactNativeFactory.h"

#import <React/RCTBundleURLProvider.h>
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import <React-RCTAppDelegate/RCTReactNativeFactory.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

// ---------------------------------------------------------------------------
// Expo brownfield delegate — resolves bundle URL exactly as the Expo integrated
// approach docs prescribe (Context7 / docs/pages/brownfield/integrated-approach.mdx):
//   DEBUG  → Metro dev server via .expo/.virtual-metro-entry
//   RELEASE → embedded main.jsbundle
// ---------------------------------------------------------------------------
@interface BridgeKitExpoBrownfieldDelegate : RCTDefaultReactNativeFactoryDelegate
@end

@implementation BridgeKitExpoBrownfieldDelegate

- (NSURL *_Nullable)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *_Nullable)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@".expo/.virtual-metro-entry"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end

// ---------------------------------------------------------------------------
// ReactNativeFactory — holds the delegate + RCTReactNativeFactory alive for
// the process lifetime so the JS engine is shared across presentations.
// ---------------------------------------------------------------------------
@interface ReactNativeFactory ()
@property (nonatomic, strong) BridgeKitExpoBrownfieldDelegate *rnDelegate;
@property (nonatomic, strong) RCTReactNativeFactory *rnFactory;
@end

@implementation ReactNativeFactory

- (instancetype)init
{
  if (self = [super init]) {
    _rnDelegate = [BridgeKitExpoBrownfieldDelegate new];
    _rnDelegate.dependencyProvider = [RCTAppDependencyProvider new];
    _rnFactory = [[RCTReactNativeFactory alloc] initWithDelegate:_rnDelegate];
  }
  return self;
}

- (UIView *)rootViewForModuleName:(NSString *)moduleName
{
  return [_rnFactory.rootViewFactory viewWithModuleName:moduleName
                                      initialProperties:@{}
                                          launchOptions:nil];
}

@end
