# BridgeKit consumer ProGuard rules.
# These rules are applied to any app that depends on this AAR.

# Keep the BridgeKitModule service interface and all implementations
# (ServiceLoader discovery requires zero-arg constructors to be kept).
-keep interface io.github.malopezr7.bridgekit.discovery.BridgeKitModule
-keep class * implements io.github.malopezr7.bridgekit.discovery.BridgeKitModule {
    <init>();
}

# Keep BridgeKitHost inline reified usage from being stripped.
-keep class io.github.malopezr7.bridgekit.discovery.BridgeKitHost { *; }

# Keep all generated contract definitions (referenced by class literals at runtime).
-keep class io.github.malopezr7.bridgekit.runtime.BridgeContractDefinition { *; }
-keep class * extends io.github.malopezr7.bridgekit.runtime.BridgeContractDefinition { *; }

# Keep BridgeValue sealed hierarchy (referenced in generated client interfaces).
-keep class io.github.malopezr7.bridgekit.runtime.BridgeValue { *; }
-keep class io.github.malopezr7.bridgekit.runtime.BridgeValue$* { *; }
