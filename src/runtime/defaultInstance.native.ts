// ---------------------------------------------------------------------------
// Default BridgeKitJs singleton — native (React Native / Metro) platform.
// Uses NitroBridgeTransport instead of LoopbackTransport.
// Metro resolves this file instead of defaultInstance.ts for RN bundles.
// ---------------------------------------------------------------------------

import { Platform } from 'react-native';
import { BridgeKitJs } from './bridgekit';
import { NitroBridgeTransport } from './nitroTransport';

const REGISTRY_SYMBOL = Symbol.for('io.github.malopezr7.bridgekit.registry');
const PACKAGE_VERSION = '83.0.0';

interface GlobalRegistry {
  instance: BridgeKitJs;
  version: string;
}

declare const __DEV__: boolean | undefined;

function isDev(): boolean {
  return typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';
}

let _default: BridgeKitJs | null = null;

/**
 * Get or create the default BridgeKitJs instance backed by NitroBridgeTransport.
 * Lazy — no top-level side effects beyond module evaluation.
 * On first call, connects to native via Nitro (calls connectDispatcher).
 */
export function getDefaultBridgeKit(): BridgeKitJs {
  if (_default !== null) return _default;

  const global = globalThis as Record<symbol, unknown>;

  if (global[REGISTRY_SYMBOL]) {
    const existing = global[REGISTRY_SYMBOL] as GlobalRegistry;
    const msg =
      `[bridgekit] Duplicate @malopezr7/bridgekit detected. ` +
      `Already loaded version: ${existing.version}, this copy: ${PACKAGE_VERSION}. ` +
      `Ensure @malopezr7/bridgekit is deduplicated in your bundle.`;
    if (isDev()) {
      throw new Error(msg);
    } else {
      console.warn(msg);
    }
    _default = existing.instance;
    return _default;
  }

  if (Platform.OS === 'ios') {
    throw new Error('BridgeKit: iOS is not yet implemented. Android-only for now.');
  }

  const transport = new NitroBridgeTransport();
  const instance = new BridgeKitJs(transport);
  instance.connect();

  const registry: GlobalRegistry = { instance, version: PACKAGE_VERSION };
  global[REGISTRY_SYMBOL] = registry;

  _default = instance;
  return _default;
}
