// ---------------------------------------------------------------------------
// LoopbackTransport — in-memory BridgeTransport where "native" == JS side.
// Enables full JS-provides + JS-consumes testing without any native layer.
// ---------------------------------------------------------------------------

import type { CallEnvelope, ResultEnvelope } from '../contract/protocol';
import { nextCorrelationId } from './correlationId';
import type { BridgeTransport, ConnectResult, JsDispatcher } from './transport';

// ---- stream/obs state -------------------------------------------------------

interface StreamEntry {
  onNext: (value: unknown) => void;
  onEnd: (end: ResultEnvelope) => void;
  epoch: number;
}

interface ObsEntry {
  onChange: (value: unknown) => void;
  contractId: string;
  member: string;
  scope: import('../contract/protocol').BridgeScope;
}

// ---- LoopbackTransport -----------------------------------------------------

export class LoopbackTransport implements BridgeTransport {
  private _dispatcher: JsDispatcher | null = null;
  private _epoch = 0;
  private _openStreams = new Map<string, StreamEntry>();
  private _obsEntries = new Map<string, ObsEntry>();
  private _streamCounter = 0;
  private _obsCounter = 0;

  // ---- connect -------------------------------------------------------------

  connect(dispatcher: JsDispatcher): ConnectResult {
    this._dispatcher = dispatcher;
    this._epoch++;
    return { epoch: this._epoch, snapshot: [] };
  }

  get currentEpoch(): number {
    return this._epoch;
  }

  // ---- invoke --------------------------------------------------------------

  async invoke(env: CallEnvelope): Promise<ResultEnvelope> {
    const dispatcher = this._dispatcher;
    if (!dispatcher) {
      return {
        ok: false,
        code: 'BRIDGE_NOT_READY',
        message: '[bridgekit] BRIDGE_NOT_READY: no dispatcher connected',
      };
    }
    const tagged = { ...env, epoch: this._epoch };
    return dispatcher.onInvoke(tagged);
  }

  // ---- invokeSync ----------------------------------------------------------

  invokeSync(_env: CallEnvelope): ResultEnvelope {
    // Loopback cannot do true sync dispatch to async dispatcher.
    // Return BRIDGE_NOT_READY for sync ops in loopback context.
    return {
      ok: false,
      code: 'BRIDGE_NOT_READY',
      message:
        '[bridgekit] invokeSync is not supported in LoopbackTransport (JS cannot be called synchronously)',
    };
  }

  // ---- openStream ----------------------------------------------------------

  openStream(
    env: CallEnvelope,
    onNext: (value: unknown) => void,
    onEnd: (end: ResultEnvelope) => void,
  ): string {
    const streamId = `stream-${++this._streamCounter}-${nextCorrelationId()}`;
    this._openStreams.set(streamId, { onNext, onEnd, epoch: this._epoch });

    const dispatcher = this._dispatcher;
    if (!dispatcher) {
      onEnd({
        ok: false,
        code: 'BRIDGE_NOT_READY',
        message: '[bridgekit] BRIDGE_NOT_READY: no dispatcher connected',
      });
      return streamId;
    }

    const tagged = { ...env, epoch: this._epoch };
    dispatcher.onStreamOpen(tagged, streamId);
    return streamId;
  }

  // ---- closeStream ---------------------------------------------------------

  closeStream(streamId: string): void {
    const entry = this._openStreams.get(streamId);
    if (!entry) return;
    this._openStreams.delete(streamId);
    this._dispatcher?.onStreamClose(streamId, 'consumer-close');
  }

  // ---- emitFromJs (JS producer → consumer) ---------------------------------

  emitFromJs(streamId: string, value: unknown): void {
    const entry = this._openStreams.get(streamId);
    if (!entry) return; // logged no-op
    if (entry.epoch !== this._epoch) return;
    entry.onNext(value);
  }

  // ---- endFromJs -----------------------------------------------------------

  endFromJs(streamId: string, end: ResultEnvelope): void {
    const entry = this._openStreams.get(streamId);
    if (!entry) return;
    this._openStreams.delete(streamId);
    entry.onEnd(end);
  }

  // ---- stateRead -----------------------------------------------------------

  stateRead(env: CallEnvelope): ResultEnvelope {
    // In loopback, state reads go through the dispatcher's registry.
    // Synchronous read is approximated by checking the registry directly.
    // (Full impl in BridgeKitJs.state() which reads the mirror.)
    const dispatcher = this._dispatcher;
    if (!dispatcher) {
      return {
        ok: false,
        code: 'BRIDGE_NOT_READY',
        message: '[bridgekit] BRIDGE_NOT_READY: no dispatcher for stateRead',
      };
    }
    // We need a sync path — loopback routes to the loopback registry state store
    const value = this._stateStore.get(
      `${env.contractId}|${JSON.stringify(env.scope)}|${env.member}`,
    );
    if (value === undefined) {
      return {
        ok: false,
        code: 'CONTRACT_NOT_PROVIDED',
        message: '[bridgekit] state not available',
      };
    }
    return { ok: true, value };
  }

  // ---- stateObserve --------------------------------------------------------

  stateObserve(env: CallEnvelope, onChange: (value: unknown) => void): string {
    const obsId = `obs-${++this._obsCounter}`;
    this._obsEntries.set(obsId, {
      onChange,
      contractId: env.contractId,
      member: env.member,
      scope: env.scope,
    });
    // Deliver current value immediately if available
    const current = this._stateStore.get(
      `${env.contractId}|${JSON.stringify(env.scope)}|${env.member}`,
    );
    if (current !== undefined) {
      onChange(current);
    }
    return obsId;
  }

  // ---- stateUnobserve ------------------------------------------------------

  stateUnobserve(obsId: string): void {
    this._obsEntries.delete(obsId);
  }

  // ---- stateWrite ----------------------------------------------------------

  stateWrite(env: CallEnvelope): ResultEnvelope {
    const key = `${env.contractId}|${JSON.stringify(env.scope)}|${env.member}`;
    this._stateStore.set(key, env.payload);
    // Notify all observers for this key
    for (const entry of this._obsEntries.values()) {
      if (
        entry.contractId === env.contractId &&
        entry.member === env.member &&
        JSON.stringify(entry.scope) === JSON.stringify(env.scope)
      ) {
        entry.onChange(env.payload);
      }
    }
    // Also route through dispatcher for JS-provided contracts
    this._dispatcher?.onStateWrite(env);
    return { ok: true };
  }

  // ---- loopback state store (mirrors the "native side" state in loopback) ----

  private readonly _stateStore = new Map<string, unknown>();

  /** Called by BridgeKitJs when a JS provider sets state via Binding.setState */
  notifyStateChange(
    contractId: string,
    scope: import('../contract/protocol').BridgeScope,
    key: string,
    value: unknown,
  ): void {
    const storeKey = `${contractId}|${JSON.stringify(scope)}|${key}`;
    this._stateStore.set(storeKey, value);
    for (const entry of this._obsEntries.values()) {
      if (
        entry.contractId === contractId &&
        entry.member === key &&
        JSON.stringify(entry.scope) === JSON.stringify(scope)
      ) {
        entry.onChange(value);
      }
    }
  }

  // ---- simulateReconnect ---------------------------------------------------

  /**
   * Simulates a JS runtime restart: bumps epoch, drops all open streams
   * with BRIDGE_NOT_READY ends. Used in tests.
   */
  simulateReconnect(): void {
    const oldEpoch = this._epoch;
    this._epoch++;

    // Drop all streams from previous epoch
    for (const [streamId, entry] of this._openStreams) {
      if (entry.epoch === oldEpoch) {
        this._openStreams.delete(streamId);
        entry.onEnd({
          ok: false,
          code: 'BRIDGE_NOT_READY',
          message: '[bridgekit] BRIDGE_NOT_READY: epoch changed (simulateReconnect)',
        });
      }
    }
  }
}
