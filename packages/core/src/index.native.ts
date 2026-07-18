// ---------------------------------------------------------------------------
// @malopezr7/bridgekit — native entry point (Metro / React Native)
//
// Same export surface as index.ts, but the default instance uses
// NitroBridgeTransport instead of LoopbackTransport.
//
// Guard: importing this file under Jest/Node without react-native-nitro-modules
// must NOT crash at import time. Nitro objects are created lazily inside
// NitroBridgeTransport on first transport call, so this module is safe to
// import in environments where NitroModules is mocked (jest.setup.native.ts).
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
export { diagnostics, setBridgeKitDevTracing } from './runtime/diagnostics';
export { LoopbackTransport } from './runtime/loopbackTransport';
export { NitroBridgeTransport } from './runtime/nitroTransport';
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

// ---- Testing utilities -----------------------------------------------------
export { createTestBridge, mockBridge } from './testing/index';

// ---- Default instance (Nitro-backed) ---------------------------------------

import { getDefaultBridgeKit } from './runtime/defaultInstance';

export { getDefaultBridgeKit } from './runtime/defaultInstance';

/**
 * Explicit wiring entry point for consumers that need control over
 * the connection moment (e.g. after ReactHost is initialized).
 * Safe to call multiple times — only the first call connects.
 */
export function initBridgeKitNative(): BridgeKitJs {
  return getDefaultBridgeKit();
}
