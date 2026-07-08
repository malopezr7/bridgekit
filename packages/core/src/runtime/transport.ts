// ---------------------------------------------------------------------------
// BridgeTransport seam — frozen interface between JS runtime and transport layer.
// Slice C will implement a Nitro-backed transport; Slice B provides LoopbackTransport.
// ---------------------------------------------------------------------------

import type { BridgeScope, CallEnvelope, ResultEnvelope } from '../contract/protocol';

export type { BridgeScope };

// ---- snapshot types -------------------------------------------------------

export interface StateSnapshotEntry {
  contractId: string;
  key: string;
  scope: BridgeScope;
  value: unknown;
}

export interface ConnectResult {
  epoch: number;
  snapshot: StateSnapshotEntry[];
  nativeProvided: Array<{ contractId: string; scope: BridgeScope }>;
}

// ---- JsDispatcher ---------------------------------------------------------

/**
 * What the JS side hands to the transport so the OTHER side can initiate.
 * Implementations must never let onInvoke reject — always resolve ResultEnvelope.
 */
export interface JsDispatcher {
  onInvoke(env: CallEnvelope): Promise<ResultEnvelope>;
  /** Start JS producer; push values via transport.emitFromJs */
  onStreamOpen(env: CallEnvelope, streamId: string): void;
  /** Dispose JS producer */
  onStreamClose(streamId: string, reason: string): void;
  /** Other side pushed a state change for a contract it provides */
  onStateWrite(env: CallEnvelope): ResultEnvelope;
}

// ---- BridgeTransport ------------------------------------------------------

export interface BridgeTransport {
  connect(dispatcher: JsDispatcher): ConnectResult;
  invoke(env: CallEnvelope): Promise<ResultEnvelope>;
  invokeSync(env: CallEnvelope): ResultEnvelope;
  openStream(
    env: CallEnvelope,
    onNext: (value: unknown) => void,
    onEnd: (end: ResultEnvelope) => void,
  ): string;
  closeStream(streamId: string): void;
  emitFromJs(streamId: string, value: unknown): void;
  endFromJs(streamId: string, end: ResultEnvelope): void;
  stateRead(env: CallEnvelope): ResultEnvelope;
  stateObserve(env: CallEnvelope, onChange: (value: unknown) => void): string;
  stateUnobserve(obsId: string): void;
  stateWrite(env: CallEnvelope): ResultEnvelope;
  /**
   * Push a JS-provider state change to the other side.
   * Called by BridgeKitJs.provide() whenever binding.setState is invoked or
   * at provide()-time to seed the initial values.
   *
   * Loopback: routes through notifyStateChange (observers + stateStore).
   * Nitro: calls stateWrite with value wrapped in { v } per the wire rule so
   * the Kotlin Router.stateWrite → StateStore.writeFromJs path fires and any
   * native stateObserve / OutboundCaller.state() StateFlow emits.
   */
  pushProviderState(contractId: string, scope: BridgeScope, key: string, value: unknown): void;

  /**
   * Announce that a JS contract is now provided, independent of state.
   * Sent at BridgeKitJs.provide() time for ALL contracts (stateful or stateless)
   * through the same BridgeState.write channel, using op='provide'.
   *
   * Native side: Router.stateWrite branches on op='provide' → markJsProvided + unpark.
   * Loopback: no-op (isProvided is already true via the in-process registry).
   */
  announceProvided(contractId: string, scope: BridgeScope): void;

  /**
   * Announce that a JS contract is no longer provided.
   * Sent on binding teardown through BridgeState.write with op='unprovide'.
   *
   * Native side: Router.stateWrite branches on op='unprovide' → markJsContractsUnprovided.
   * Loopback: no-op (registry handles teardown in-process).
   */
  announceUnprovided(contractId: string, scope: BridgeScope): void;
}
