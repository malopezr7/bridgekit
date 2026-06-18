#import "ReactNativeFactory.h"

#import <React/RCTBundleURLProvider.h>
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import <React-RCTAppDelegate/RCTReactNativeFactory.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

@interface BridgeKitExampleReactNativeDelegate : RCTDefaultReactNativeFactoryDelegate
@end

@implementation BridgeKitExampleReactNativeDelegate

- (NSURL *_Nullable)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end

@interface ReactNativeFactory ()
@property (nonatomic, strong) BridgeKitExampleReactNativeDelegate *delegate;
@property (nonatomic, strong) RCTReactNativeFactory *factory;
@end

@implementation ReactNativeFactory

- (instancetype)init
{
  if (self = [super init]) {
    _delegate = [BridgeKitExampleReactNativeDelegate new];
    _delegate.dependencyProvider = [RCTAppDependencyProvider new];
    _factory = [[RCTReactNativeFactory alloc] initWithDelegate:_delegate];
  }

  return self;
}

- (void)startReactNativeWithModuleName:(NSString *)moduleName
                              inWindow:(UIWindow *_Nullable)window
                         launchOptions:(NSDictionary *_Nullable)launchOptions
{
  [_factory startReactNativeWithModuleName:moduleName inWindow:window launchOptions:launchOptions];
}

@end
