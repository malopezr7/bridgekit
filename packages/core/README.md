# @malopezr7/bridgekit

Typed, bidirectional communication between React Native and native code via a **Marker API**.
One TypeScript contract definition drives JS types, runtime metadata, and generated Kotlin.

Platform support: **Android implemented**. iOS is deferred — the runtime throws a legible error on iOS
construction (see `defaultInstance.native.ts`). Web uses an in-memory loopback (no native transport).

See the source and tests for the full architecture.

---

## Quick Start — Marker API

### 1. Define a contract (TypeScript, single source of truth)

```ts
// connect-host.contract.ts — provided by NATIVE, consumed by JS
import { defineContract, Async, Void, Stream, State } from '@malopezr7/bridgekit/contract';

export const ConnectHost = defineContract('connect.host', {
  methods: {
    isLoggedIn: Async<boolean>(),
    installEsim: Async<{ url: string; iccId: string }, 'success' | 'cancelled' | 'error'>(),
    showLogin: Void(),
  },
  streams: {
    otpCodes: Stream<string>(),
  },
  state: {
    connectivity: State<{ online: boolean }>({ online: false }),
  },
});
```

Marker reference:
- `Async<Result>()` / `Async<Params, Result>()` — async request/response
- `Sync<Result>()` / `Sync<Params, Result>()` — sync read (native-provided only)
- `Void()` / `Void<Params>()` — fire-and-forget
- `Stream<Value>()` / `Stream<Value, Params>()` — typed observable flow
- `State<Value>(initial)` — observable bidirectional state

### 2. Generate Kotlin bindings

```bash
bridgekit generate \
  --contracts 'src/**/*.contract.ts' \
  --out-dir android/src/main/java/com/myapp/bridgekit/generated
```

This produces `ConnectHostContract.kt` — interface, data classes, codecs, and a contract object.

### 3. Provide from native (Kotlin)

```kotlin
class ConnectHostProvider : ConnectHost {
  override suspend fun isLoggedIn(): Boolean = session.isLoggedIn()
  override suspend fun installEsim(params: InstallEsimParams): InstallEsimResult = /* ... */
  override fun showLogin() { /* ... */ }
  override fun otpCodes(): Flow<String> = smsRetriever.codes()
  override val connectivity = MutableStateFlow(Connectivity(online = true))
}

BridgeKit.default.provide(ConnectHostContract) { ConnectHostProvider() }
```

### 4. Consume from React Native

```tsx
import { useBridge, useBridgeState } from '@malopezr7/bridgekit/react';
import { ConnectHost } from './connect-host.contract';

function LoginButton() {
  const connect = useBridge(ConnectHost);
  const { value, status } = useBridgeState(ConnectHost, 'connectivity');

  return (
    <Button
      title={value?.online ? 'Connected' : 'Offline'}
      onPress={() => connect.showLogin()}
    />
  );
}
```

### 5. Provide from React Native (JS → native direction)

```tsx
import { useProvideBridge } from '@malopezr7/bridgekit/react';
import { LiaFeature } from './lia-feature.contract';

function LiaProvider({ children }) {
  useProvideBridge(LiaFeature, {
    getUnreadCount: () => store.unread,
  });
  return children;
}
```

```kotlin
val lia = bridgeKit.consume(LiaFeatureContract)
val count = lia.getUnreadCount()
```

---

## ContractHook (React integration)

`ContractHook` is the React-first way to consume a contract. It returns a derived consumer
that re-renders automatically when any subscribed state changes.

```ts
import { defineContract, Async, State } from '@malopezr7/bridgekit/contract';

const UserContract = defineContract('user.contract', {
  methods: {
    getProfile: Async<{ userId: string }, { name: string; email: string }>(),
  },
  state: {
    loginStatus: State<'idle' | 'active' | 'error'>('idle'),
  },
});

// In a React component:
const user = UserContract.hook();
// user.loginStatus.value — reactive, re-renders on change
// user.loginStatus.status — 'provided' | 'unprovided' | 'stale'
// user.getProfile({ userId }) — returns Promise<{ name, email }>
```

---

## Scoping

Use `BridgeScopeProvider` to isolate contracts to a feature or instance:

```tsx
import { BridgeScopeProvider } from '@malopezr7/bridgekit/react';

// Feature scope — multiple instances of the same feature do not cross-talk
<BridgeScopeProvider feature="checkout" instance={cartId}>
  <CheckoutFlow />
</BridgeScopeProvider>
```

---

## Auto-discovery (native feature modules)

```kotlin
class ConnectBridgeModule : BridgeKitModule {
  override fun register(bridgekit: BridgeKit, host: BridgeKitHost) {
    bridgekit.provide(ConnectHostContract) { ConnectHostProvider(host.locate()) }
  }
}
// Register via META-INF/services/io.github.malopezr7.bridgekit.discovery.BridgeKitModule
```

---

## Testing

```ts
import { createTestBridge } from '@malopezr7/bridgekit/test';

const { bridgekit } = createTestBridge();
await bridgekit.provide(ConnectHost, { isLoggedIn: async () => true });
const proxy = bridgekit.bridge(ConnectHost);
expect(await proxy.isLoggedIn()).toBe(true);
```

```kotlin
val fake = object : ConnectHost { /* ... */ }
val bridgekit = BridgeKit(testTransport)
```

---

## Diagnostics

`BridgeKit.default.dump()` returns live state:

```ts
const state = BridgeKit.default.dump();
// state.bindings    — registered providers per contract+scope
// state.mirrors     — observable state mirrors per contract+scope
// state.openStreams  — current count of open stream subscriptions
// state.streamDrops  — cumulative items dropped by bounded consumer queues
// state.counters     — { calls, errors, firesDropped }
// state.epoch        — current connection generation
```

On Android: `BridgeKit.default.dump()` logs to Logcat under the `BridgeKit` tag.
