// ---------------------------------------------------------------------------
// Default BridgeKitJs singleton — registered under Symbol.for('com.bridgekit.registry').
// Second copy throws in dev / warns in prod.
// ---------------------------------------------------------------------------

import { BridgeKitJs } from './bridgekit';
import { isBridgeKitDev } from './env';
import { LoopbackTransport } from './loopbackTransport';

const REGISTRY_SYMBOL = Symbol.for('com.bridgekit.registry');
const PACKAGE_VERSION = '83.0.0';

interface GlobalRegistry {
  instance: BridgeKitJs;
  version: string;
}

let _default: BridgeKitJs | null = null;

/**
 * Get or create the default BridgeKitJs instance (loopback-backed).
 * Lazy — no top-level side effects beyond module evaluation.
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
    if (isBridgeKitDev()) {
      throw new Error(msg);
    } else {
      console.warn(msg);
    }
    _default = existing.instance;
    return _default;
  }

  const transport = new LoopbackTransport();
  const instance = new BridgeKitJs(transport);
  instance.connect();

  const registry: GlobalRegistry = { instance, version: PACKAGE_VERSION };
  global[REGISTRY_SYMBOL] = registry;

  _default = instance;
  return _default;
}
