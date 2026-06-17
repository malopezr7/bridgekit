import type { AnyMap, HybridObject } from 'react-native-nitro-modules';

/**
 * BridgeHost — core invoke channel + dispatcher registration.
 *
 * Wire rule: every payload value is wrapped as { v: <value> } by the JS
 * transport so that AnyMap (map-only) can carry arbitrary JS values including
 * primitives and arrays. The Kotlin side mirrors this { v: ... } convention.
 */
export interface BridgeHost
  extends HybridObject<{
    ios: 'swift';
    android: 'kotlin';
  }> {
  /**
   * Async invoke — native routes the envelope to the Kotlin registry.
   * Envelope fields match CallEnvelope (§4.1); payload is pre-encoded.
   */
  invoke(env: AnyMap): Promise<AnyMap>;

  /**
   * Synchronous invoke — querySync channel; called on the JS thread.
   * Kotlin must only perform lock-free in-memory reads on this path.
   */
  invokeSync(env: AnyMap): AnyMap;

  /**
   * Register the JS dispatcher for this runtime epoch.
   * Returns { epoch: number, snapshot: AnyMap[] } — snapshot entries follow
   * StateSnapshotEntry shape wrapped per the { v: } wire rule.
   *
   * Callbacks are held for the full epoch lifetime:
   *   - onInvoke: routes native→JS method calls; returns Promise<AnyMap>
   *   - onStreamOpen: signals that a JS-provided stream should start emitting
   *   - onStreamClose: signals teardown of a native-side stream consumer
   *   - onStateWrite: native pushes a state-change notification to JS mirrors
   */
  connectDispatcher(
    epochInfo: AnyMap,
    onInvoke: (env: AnyMap) => Promise<AnyMap>,
    onStreamOpen: (env: AnyMap) => void,
    onStreamClose: (env: AnyMap) => void,
    onStateWrite: (env: AnyMap) => void,
  ): AnyMap;
}
