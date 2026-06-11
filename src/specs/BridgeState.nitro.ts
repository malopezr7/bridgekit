import type { AnyMap, HybridObject } from 'react-native-nitro-modules';

/**
 * BridgeState — observable state channel.
 *
 * Wire rule: state values are wrapped { v: <encoded-value> } in onChange
 * callbacks; read/write results follow ResultEnvelope shape as AnyMap.
 */
export interface BridgeState
  extends HybridObject<{
    ios: 'swift';
    android: 'kotlin';
  }> {
  /**
   * Synchronous state read.
   * Serves querySync-class reads and mirror hydration.
   * Returns ResultEnvelope as AnyMap — { ok: true, v: <encoded-value> } or error.
   */
  read(env: AnyMap): AnyMap;

  /**
   * Subscribe to state changes from native.
   * Returns an obsId (epoch-scoped, opaque string).
   * onChange receives { v: <encoded-value> } each time the state changes.
   */
  observe(env: AnyMap, onChange: (value: AnyMap) => void): string;

  /** Cancel a state observation. No-op if obsId is unknown or stale. */
  unobserve(obsId: string): void;

  /**
   * Provider-side state write from JS.
   * The router rejects with NOT_PROVIDER if the origin side doesn't own the binding.
   * Returns ResultEnvelope as AnyMap.
   */
  write(env: AnyMap): AnyMap;
}
