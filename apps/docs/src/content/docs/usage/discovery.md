---
title: Auto-discovery (Android)
description: ServiceLoader-based registration for global-scope providers shipped in feature AARs, the BridgeKitHost dependency locator, ordering and R8 rules. iOS uses explicit registration instead.
sidebar:
  order: 5
---

This page covers **Android auto-discovery**. `java.util.ServiceLoader` and R8 rules are JVM
concepts. iOS has no equivalent mechanism — see [Swift: provide & consume](/usage/swift/) for
how iOS providers are registered explicitly.

A feature shipped as an AAR needs its global-scope providers registered without the host app
wiring each one by hand. BridgeKit uses `java.util.ServiceLoader` for that — **global scope
only**.

## A discovery module

```kotlin
class AppBridgeModule : BridgeKitModule {
  override fun register(bridgekit: BridgeKit, host: BridgeKitHost) {
    // host carries the Application Context + the host-installed dependency locator
    bridgekit.provide(SegmentsContract, Scope.global) { SegmentsProvider(host.locate()) }
  }
}
```

Register it as a service:

```text
// META-INF/services/com.bridgekit.discovery.BridgeKitModule
com.example.app.AppBridgeModule
```

`BridgeKit.initialize(host)` runs `ServiceLoader.load` + each `register()`.

## `BridgeKitHost` — the DI bridge

Real providers need the DI graph (use cases, repos), but ServiceLoader instantiates
zero-arg classes. `BridgeKitHost` solves that: the host installs its **dependency locator**
once during BridgeKit init — the same place `ReactManager.setBridgeKitDependencies` lives today — and
modules call `host.locate()` to reach it. Factories stay lazy (resolved on first use);
`eager = true` opts in.

## Ordering guarantee

`ServiceLoader.load` + all `register()` calls complete **synchronously inside BridgeKit
init**, which runs **before** `reactHost.start()`. So global state is sync-readable at the
first JS render — guaranteed, not racy.

## R8 / minification

BridgeKit's AAR ships consumer rules so discovery survives a minified release build:

```text
-keep interface com.bridgekit.BridgeKitModule
-keep class * implements com.bridgekit.BridgeKitModule { <init>(); }
```

Minified-release discovery is one of the on-device acceptance criteria.

## What ServiceLoader does *not* cover

ServiceLoader is for **global** providers only. **Instance** and **feature** contracts are
always provided through scope handles in host code — a feature fragment creates a
`BridgeKitScope` when its surface starts and provides into it. Two ServiceLoader modules
claiming the same global id is a **hard error at init**.

## iOS: no ServiceLoader — explicit registration required

iOS has no `ServiceLoader` equivalent. Every provider must be registered explicitly in app
code before the React Native bridge initializes — typically in
`AppDelegate.application(_:didFinishLaunchingWithOptions:)` or the `@main` App body:

```swift
import BridgeKit

// In AppDelegate, before the bridge starts:
_ = BridgeKitRuntime.default.provide(ExampleHostContract()) { ExampleHostImpl() }
```

Feature-scoped providers are registered when the feature surface appears and closed when it
disappears. See [Swift: provide & consume](/usage/swift/) for the full API and scope
options, and [Installation](/start/installation/) for the iOS target setup.
