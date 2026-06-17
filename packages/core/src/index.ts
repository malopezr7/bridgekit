// ---------------------------------------------------------------------------
// @malopezr7/bridgekit — main entry point
//
// Exports: contract layer + runtime + react layer.
// Default BridgeKitJs instance is created LAZILY on first access via getDefaultBridgeKit().
// No top-level connect side effect; connect() is called inside getDefaultBridgeKit().
// Slice C will add index.native.ts for the Nitro-backed transport.
// ---------------------------------------------------------------------------

// ---- Contract layer (pure, zero side effects) ------------------------------
export * from './contract';
// ---- React layer -----------------------------------------------------------
export {
  BridgeScopeProvider,
  useBridge,
  useBridgeReady,
  useBridgeState,
  useProvideBridge,
} from './react/hooks';
export type { BridgeCallOpts } from './runtime/bridgekit';
// ---- Runtime ---------------------------------------------------------------
export { BridgeKitJs, getAmbientScope, setAmbientScope } from './runtime/bridgekit';
export { getDefaultBridgeKit } from './runtime/defaultInstance';
export { diagnostics, setBridgeKitDevTracing } from './runtime/diagnostics';
export { LoopbackTransport } from './runtime/loopbackTransport';
export type { Binding } from './runtime/registry';
export {
  fromAsyncIterable,
  GLOBAL_SCOPE,
  Registry,
  serializeScope,
  streamSource,
} from './runtime/registry';
export type {
  BridgeTransport,
  ConnectResult,
  JsDispatcher,
  StateSnapshotEntry,
} from './runtime/transport';

// ---- Testing utilities (re-exported for convenience) -----------------------
// Note: importing these in production is safe — they have no side effects.
// Bundle-splitting is the consumer's responsibility.
export { createTestBridge, mockBridge } from './testing/index';
