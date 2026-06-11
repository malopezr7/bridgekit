# @malopezr7/bridgekit

Typed, bidirectional communication between React Native and native code: contracts, providers, reactive streams and observable state. One contract definition in TypeScript drives everything — JS types, runtime metadata, and generated Kotlin.

See the source and tests for the full architecture.

## Define a contract (TS, single source of truth)

```ts
// connect-host.contract.ts
import { defineContract, t } from '@malopezr7/bridgekit/contract';

export const ConnectHost = defineContract('connect.host', {
  methods: {
    showLogin: t.fire(),
    isLoggedIn: t.query(t.boolean()),
    installEsim: t.query(
      t.object({ url: t.string(), iccId: t.string() }),
      t.literals('success', 'already-installed', 'cancelled', 'error'),
      { timeoutMs: null },
    ),
  },
  streams: {
    otpCodes: t.stream(t.string()),
  },
  state: {
    connectivity: t.state(t.object({ online: t.boolean() }), { online: false }),
  },
});
```

Generate the Kotlin bindings:

```bash
bridgekit generate --contracts 'src/**/*.contract.ts' --out-dir bridgekit/generated
```

## Provide from native (Kotlin)

```kotlin
class ConnectHostProvider : ConnectHost {
  override fun showLogin() { /* ... */ }
  override suspend fun isLoggedIn(): Boolean = session.isLoggedIn()
  override suspend fun installEsim(params: InstallEsimParams): InstallEsimResult = /* ... */
  override fun otpCodes(): Flow<String> = smsRetriever.codes()
  override val connectivity = MutableStateFlow(Connectivity(online = true))
}

BridgeKit.default.provide(ConnectHostContract) { ConnectHostProvider() }
```

## Consume from React Native

```tsx
const connect = useBridge(ConnectHost);
const result = await connect.installEsim({ url, iccId });

const codes = connect.otpCodes();           // subscribe() or `for await`
const { value } = useBridgeState(ConnectHost, 'connectivity');
```

## The other direction: RN provides, native consumes

```tsx
useProvideBridge(LiaFeature, { getUnreadCount: () => store.unread });
```

```kotlin
val lia = bridgekit.consume(LiaFeatureContract)
val count = lia.getUnreadCount()
lia.sessionStatus.collect { value -> /* BridgeValue<SessionStatus> */ }
```

## Auto-discovery (feature AARs)

```kotlin
class ConnectBridgeModule : BridgeKitModule {
  override fun register(bridgekit: BridgeKit, host: BridgeKitHost) {
    bridgekit.provide(ConnectHostContract) { ConnectHostProvider(host.locate()) }
  }
}
// + META-INF/services/io.github.malopezr7.bridgekit.discovery.BridgeKitModule
```

## Testing

```ts
const mock = mockBridge(ConnectHost, { isLoggedIn: async () => true });
const { bridgekit } = createTestBridge(); // in-memory loopback, no native needed
```

```kotlin
val fake = object : ConnectHost { /* ... */ }
val bridgekit = BridgeKit(testTransport)
```

## Debugging

`BridgeKit.dump()` (both sides) prints bindings, open streams, state values and epoch. Structured per-op traces are emitted in dev builds on both JS console and logcat under the `BridgeKit` tag.
