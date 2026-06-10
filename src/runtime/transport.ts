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
  onStateWrite(env: CallEnvelope): void;
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
}
