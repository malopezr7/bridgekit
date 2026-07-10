// ---------------------------------------------------------------------------
// NitroBridgeTransport — BridgeTransport backed by Nitro hybrid objects.
// Lazily creates BridgeHost / BridgeStreams / BridgeState on first use.
//
// Wire format (AnyMap limits — no nested callbacks, no binary):
//   CallEnvelope fields map 1:1 to plain object keys.
//   Payload values are NOT double-wrapped here — the codec layer owns encoding.
//   Stream values pushed via emitFromJs are wrapped { v: <value> } before
//   crossing into AnyMap so AnyMap (map-only) can carry primitives and arrays.
//   StateObserve onChange receives { v: <value> } from native.
//   ResultEnvelope crosses the bridge as a plain AnyMap: { ok, value?, code?, ... }
// ---------------------------------------------------------------------------

import type { AnyMap } from 'react-native-nitro-modules';
import { NitroModules } from 'react-native-nitro-modules';

import type { CallEnvelope, ResultEnvelope } from '../contract/protocol';
import type { BridgeHost } from '../specs/BridgeHost.nitro';
import type { BridgeState } from '../specs/BridgeState.nitro';
import type { BridgeStreams } from '../specs/BridgeStreams.nitro';
import type { BridgeTransport, ConnectResult, JsDispatcher, StateSnapshotEntry } from './transport';

// ---- AnyMap helpers ---------------------------------------------------------

/** Serialize a CallEnvelope to a plain object that fits AnyMap. */
function envelopeToMap(env: CallEnvelope): Record<string, unknown> {
  const map: Record<string, unknown> = {
    op: env.op,
    contractId: env.contractId,
    member: env.member,
    correlationId: env.correlationId,
    epoch: env.epoch,
    scope: env.scope as unknown,
  };
  if (env.payload !== undefined) {
    map.payload = env.payload;
  }
  // Carry the caller's contractHash on the hot path for wire skew detection (D2).
  if (env.contractHash !== undefined) {
    map.contractHash = env.contractHash;
  }
  if (env.latestOnly !== undefined) {
    map.latestOnly = env.latestOnly;
  }
  if (env.sticky !== undefined) {
    map.sticky = env.sticky;
  }
  return map;
}

/** Deserialize a plain AnyMap-sourced object to a ResultEnvelope. */
function mapToResult(map: Record<string, unknown>): ResultEnvelope {
  if (map.ok === true) {
    return { ok: true, value: map.value };
  }
  return {
    ok: false,
    code:
      (map.code as ResultEnvelope extends { ok: false } ? typeof map.code : never) ??
      'PROVIDER_ERROR',
    message: (map.message as string | undefined) ?? '[bridgekit] unknown error from native',
    contractId: map.contractId as string | undefined,
    member: map.member as string | undefined,
    scope: map.scope as CallEnvelope['scope'] | undefined,
    // Carry skew-diff details (e.g. INCOMPATIBLE_CONTRACT callerHash/receiverHash).
    details: map.details,
  };
}

/** Serialize a ResultEnvelope to a plain object that fits AnyMap. */
function resultToMap(res: ResultEnvelope): Record<string, unknown> {
  if (res.ok) {
    const map: Record<string, unknown> = { ok: true };
    if (res.value !== undefined) map.value = res.value;
    return map;
  }
  const map: Record<string, unknown> = {
    ok: false,
    code: res.code,
    message: res.message,
  };
  if (res.contractId !== undefined) map.contractId = res.contractId;
  if (res.member !== undefined) map.member = res.member;
  if (res.scope !== undefined) map.scope = res.scope;
  if (res.details !== undefined) map.details = res.details;
  return map;
}

/** Deserialize a plain object from the native side back to a CallEnvelope. */
function mapToEnvelope(map: Record<string, unknown>): CallEnvelope {
  return {
    op: map.op as CallEnvelope['op'],
    contractId: map.contractId as string,
    member: map.member as string,
    scope: map.scope as CallEnvelope['scope'],
    payload: map.payload,
    correlationId: (map.correlationId as string | undefined) ?? '',
    epoch: (map.epoch as number | undefined) ?? 0,
    contractHash: map.contractHash as string | undefined,
    latestOnly: map.latestOnly as boolean | undefined,
    sticky: map.sticky as boolean | undefined,
    seq: map.seq as number | undefined,
  };
}

// ---- NitroBridgeTransport ---------------------------------------------------

export class NitroBridgeTransport implements BridgeTransport {
  private _host: BridgeHost | null = null;
  private _streams: BridgeStreams | null = null;
  private _state: BridgeState | null = null;
  private _epoch = 0;

  // ---- lazy hybrid object access -------------------------------------------

  private _getHost(): BridgeHost {
    if (!this._host) {
      this._host = NitroModules.createHybridObject<BridgeHost>('BridgeHost');
    }
    return this._host;
  }

  private _getStreams(): BridgeStreams {
    if (!this._streams) {
      this._streams = NitroModules.createHybridObject<BridgeStreams>('BridgeStreams');
    }
    return this._streams;
  }

  private _getState(): BridgeState {
    if (!this._state) {
      this._state = NitroModules.createHybridObject<BridgeState>('BridgeState');
    }
    return this._state;
  }

  // ---- connect -------------------------------------------------------------

  connect(dispatcher: JsDispatcher): ConnectResult {
    const host = this._getHost();

    const result = host.connectDispatcher(
      {} as AnyMap,
      // onInvoke: native→JS async method call.
      // Returns Promise<AnyMap>; NEVER rejects — try/catch → ok:false envelope.
      (envMap: AnyMap): Promise<AnyMap> => {
        const env = mapToEnvelope(envMap as unknown as Record<string, unknown>);
        return dispatcher
          .onInvoke(env)
          .catch((err: unknown) => ({
            ok: false as const,
            code: 'PROVIDER_ERROR' as const,
            message: `[bridgekit] PROVIDER_ERROR (uncaught in dispatcher): ${String(err)}`,
            contractId: env.contractId,
            member: env.member,
            scope: env.scope,
          }))
          .then((res) => resultToMap(res) as unknown as AnyMap);
      },
      // onStreamOpen: native signals a JS-provided stream to start emitting.
      (envMap: AnyMap): void => {
        const map = envMap as unknown as Record<string, unknown>;
        const env = mapToEnvelope(map);
        const streamId = (map.streamId as string | undefined) ?? '';
        dispatcher.onStreamOpen(env, streamId);
      },
      // onStreamClose: native cancels a JS-provided stream consumer.
      // envMap = { streamId: string, reason: string }
      (envMap: AnyMap): void => {
        const map = envMap as unknown as Record<string, unknown>;
        const streamId = (map.streamId as string | undefined) ?? '';
        const reason = (map.reason as string | undefined) ?? 'native-close';
        dispatcher.onStreamClose(streamId, reason);
      },
      // onStateWrite: native pushes a state-change to JS mirrors.
      (envMap: AnyMap): void => {
        const env = mapToEnvelope(envMap as unknown as Record<string, unknown>);
        // Frozen Nitro JSI seam: native callback type is void. The dispatcher
        // still observes hash skew here, but strict rejections cannot be
        // returned to native writers through this generated callback.
        dispatcher.onStateWrite(env);
      },
    ) as unknown as Record<string, unknown>;

    // Parse { epoch: number, snapshot: AnyMap[], nativeProvided: AnyMap[] }.
    // Native uses epoch 0 as the pre-connection sentinel; preserve that sentinel
    // when old or malformed native payloads omit epoch instead of masking to 1.
    const rawEpoch = result.epoch;
    const epoch = typeof rawEpoch === 'number' && Number.isFinite(rawEpoch) ? rawEpoch : 0;
    this._epoch = epoch;

    const rawSnapshot = (result.snapshot as unknown[] | undefined) ?? [];
    const snapshot: StateSnapshotEntry[] = rawSnapshot.map((entry) => {
      const e = entry as Record<string, unknown>;
      return {
        contractId: (e.contractId as string | undefined) ?? '',
        key: (e.key as string | undefined) ?? '',
        scope: (e.scope as CallEnvelope['scope'] | undefined) ?? {
          kind: 'global' as const,
        },
        // Snapshot entries are already single-wrapped by native: entry.v is the plain value.
        value: e.v,
      };
    });

    const rawNativeProvided = (result.nativeProvided as unknown[] | undefined) ?? [];
    const nativeProvided = rawNativeProvided.map((entry) => {
      const e = entry as Record<string, unknown>;
      return {
        contractId: (e.contractId as string | undefined) ?? '',
        scope: (e.scope as CallEnvelope['scope'] | undefined) ?? {
          kind: 'global' as const,
        },
      };
    });

    return { epoch, snapshot, nativeProvided };
  }

  // ---- invoke --------------------------------------------------------------

  async invoke(env: CallEnvelope): Promise<ResultEnvelope> {
    const tagged = { ...env, epoch: this._epoch };
    try {
      const raw = await this._getHost().invoke(envelopeToMap(tagged) as unknown as AnyMap);
      return mapToResult(raw as unknown as Record<string, unknown>);
    } catch (err) {
      return {
        ok: false,
        code: 'PROVIDER_ERROR',
        message: `[bridgekit] PROVIDER_ERROR (invoke threw): ${String(err)}`,
        contractId: env.contractId,
        member: env.member,
        scope: env.scope,
      };
    }
  }

  // ---- invokeSync ----------------------------------------------------------

  invokeSync(env: CallEnvelope): ResultEnvelope {
    const tagged = { ...env, epoch: this._epoch };
    try {
      const raw = this._getHost().invokeSync(envelopeToMap(tagged) as unknown as AnyMap);
      return mapToResult(raw as unknown as Record<string, unknown>);
    } catch (err) {
      return {
        ok: false,
        code: 'PROVIDER_ERROR',
        message: `[bridgekit] PROVIDER_ERROR (invokeSync threw): ${String(err)}`,
        contractId: env.contractId,
        member: env.member,
        scope: env.scope,
      };
    }
  }

  // ---- openStream ----------------------------------------------------------

  openStream(
    env: CallEnvelope,
    onNext: (value: unknown) => void,
    onEnd: (end: ResultEnvelope) => void,
  ): string {
    const tagged = { ...env, epoch: this._epoch };
    return this._getStreams().open(
      envelopeToMap(tagged) as unknown as AnyMap,
      // onNext receives { v: <encoded-value> } per wire rule — unwrap v here.
      (valueMap: AnyMap): void => {
        const map = valueMap as unknown as Record<string, unknown>;
        onNext(map.v);
      },
      // onEnd receives a ResultEnvelope map — pass through after deserialization.
      (endMap: AnyMap): void => {
        onEnd(mapToResult(endMap as unknown as Record<string, unknown>));
      },
    );
  }

  // ---- closeStream ---------------------------------------------------------

  closeStream(streamId: string): void {
    this._getStreams().close(streamId);
  }

  // ---- emitFromJs (JS producer → native consumer) -------------------------

  emitFromJs(streamId: string, value: unknown): void {
    // Wrap in { v } so AnyMap (map-only) can carry primitives and arrays.
    this._getStreams().emitFromJs(streamId, { v: value } as unknown as AnyMap);
  }

  // ---- endFromJs -----------------------------------------------------------

  endFromJs(streamId: string, end: ResultEnvelope): void {
    this._getStreams().endFromJs(streamId, resultToMap(end) as unknown as AnyMap);
  }

  // ---- stateRead -----------------------------------------------------------

  stateRead(env: CallEnvelope): ResultEnvelope {
    const tagged = { ...env, epoch: this._epoch };
    try {
      const raw = this._getState().read(envelopeToMap(tagged) as unknown as AnyMap);
      return mapToResult(raw as unknown as Record<string, unknown>);
    } catch (err) {
      return {
        ok: false,
        code: 'PROVIDER_ERROR',
        message: `[bridgekit] PROVIDER_ERROR (stateRead threw): ${String(err)}`,
        contractId: env.contractId,
        member: env.member,
        scope: env.scope,
      };
    }
  }

  // ---- stateObserve --------------------------------------------------------

  stateObserve(env: CallEnvelope, onChange: (value: unknown) => void): string {
    const tagged = { ...env, epoch: this._epoch };
    return this._getState().observe(
      envelopeToMap(tagged) as unknown as AnyMap,
      // onChange receives { v: <encoded-value> } per wire rule — unwrap v.
      (valueMap: AnyMap): void => {
        const map = valueMap as unknown as Record<string, unknown>;
        onChange(map.v);
      },
    );
  }

  // ---- stateUnobserve ------------------------------------------------------

  stateUnobserve(obsId: string): void {
    this._getState().unobserve(obsId);
  }

  // ---- stateWrite ----------------------------------------------------------

  stateWrite(env: CallEnvelope): ResultEnvelope {
    const tagged = { ...env, epoch: this._epoch };
    try {
      const raw = this._getState().write(envelopeToMap(tagged) as unknown as AnyMap);
      return mapToResult(raw as unknown as Record<string, unknown>);
    } catch (err) {
      return {
        ok: false,
        code: 'PROVIDER_ERROR',
        message: `[bridgekit] PROVIDER_ERROR (stateWrite threw): ${String(err)}`,
        contractId: env.contractId,
        member: env.member,
        scope: env.scope,
      };
    }
  }

  // ---- pushProviderState (JS provider → Kotlin StateStore) ----------------

  /**
   * Push a JS-provider state change to native via stateWrite.
   * Value is wrapped { v: <value> } per the AnyMap wire rule before crossing.
   * Kotlin Router.stateWrite → StateStore.writeFromJs(nativeOwns=false)
   * updates the store and notifies any native stateObserve callbacks and
   * the OutboundCaller.state() StateFlow so native consumers observe updates.
   */
  pushProviderState(
    contractId: string,
    scope: import('./transport').BridgeScope,
    key: string,
    value: unknown,
  ): void {
    const env: CallEnvelope = {
      op: 'stateWrite',
      contractId,
      member: key,
      scope,
      // Wrap in { v } per wire rule: AnyMap is map-only, cannot carry bare primitives
      payload: { v: value },
      correlationId: '',
      epoch: this._epoch,
    };
    this.stateWrite(env);
  }

  // ---- announceProvided / announceUnprovided --------------------------------

  /**
   * Announce that a JS contract is now provided, state-independently.
   * Sends {op:'provide'} through the same BridgeState.write Nitro channel.
   * Kotlin Router.stateWrite branches on op='provide' → markJsProvided + unpark,
   * without touching the state store. No new Nitro spec method required.
   */
  announceProvided(contractId: string, scope: import('./transport').BridgeScope): void {
    const env: CallEnvelope = {
      op: 'provide',
      contractId,
      member: '',
      scope,
      correlationId: '',
      epoch: this._epoch,
    };
    this.stateWrite(env);
  }

  /**
   * Announce that a JS contract is no longer provided.
   * Sends {op:'unprovide'} through BridgeState.write.
   * Kotlin Router.stateWrite branches on op='unprovide' → markJsContractsUnprovided.
   */
  announceUnprovided(contractId: string, scope: import('./transport').BridgeScope): void {
    const env: CallEnvelope = {
      op: 'unprovide',
      contractId,
      member: '',
      scope,
      correlationId: '',
      epoch: this._epoch,
    };
    this.stateWrite(env);
  }
}
