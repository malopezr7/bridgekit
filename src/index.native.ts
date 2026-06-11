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

import { BridgeKitJs } from './runtime/bridgekit';
import { NitroBridgeTransport } from './runtime/nitroTransport';

const REGISTRY_SYMBOL = Symbol.for('io.github.malopezr7.bridgekit.registry');
const PACKAGE_VERSION = '83.0.0';

interface GlobalRegistry {
  instance: BridgeKitJs;
  version: string;
}

declare const __DEV__: boolean | undefined;

function _isDev(): boolean {
  return typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';
}

let _nativeDefault: BridgeKitJs | null = null;
let _connected = false;

/**
 * Get or create the default BridgeKitJs instance backed by NitroBridgeTransport.
 * Lazy — no connection side effects at import time.
 * On first call, connects to native (calls connectDispatcher via Nitro).
 */
export function getDefaultBridgeKit(): BridgeKitJs {
  if (_nativeDefault !== null) return _nativeDefault;

  const global = globalThis as Record<symbol, unknown>;

  if (global[REGISTRY_SYMBOL]) {
    const existing = global[REGISTRY_SYMBOL] as GlobalRegistry;
    const msg =
      `[bridgekit] Duplicate @malopezr7/bridgekit detected. ` +
      `Already loaded version: ${existing.version}, this copy: ${PACKAGE_VERSION}. ` +
      `Ensure @malopezr7/bridgekit is deduplicated in your bundle.`;
    if (_isDev()) {
      throw new Error(msg);
    } else {
      console.warn(msg);
    }
    _nativeDefault = existing.instance;
    return _nativeDefault;
  }

  const transport = new NitroBridgeTransport();
  const instance = new BridgeKitJs(transport);
  // Connect lazily on first getDefaultBridgeKit call — safe because Nitro
  // objects are created inside the transport only when methods are called.
  instance.connect();
  _connected = true;

  const registry: GlobalRegistry = { instance, version: PACKAGE_VERSION };
  global[REGISTRY_SYMBOL] = registry;

  _nativeDefault = instance;
  return _nativeDefault;
}

/**
 * Explicit wiring entry point for consumers that need control over
 * the connection moment (e.g. after ReactHost is initialized).
 * Safe to call multiple times — only the first call connects.
 */
export function initBridgeKitNative(): BridgeKitJs {
  return getDefaultBridgeKit();
}
