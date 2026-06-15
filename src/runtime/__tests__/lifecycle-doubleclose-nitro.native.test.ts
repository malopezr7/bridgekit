// Regression: stale double-close over Nitro transport must NOT emit {v:undefined} + unprovide
// for a B-owned key. C-3: wasLive gate prevents stale close from corrupting native state.
import { describe, expect, it } from '@jest/globals';
import { defineContract } from '../../contract/contract';
import { State } from '../../contract/markers';
import type { CallEnvelope, ResultEnvelope } from '../../contract/protocol';
import { t } from '../../contract/schema';
import { BridgeKitJs } from '../bridgekit';
import { GLOBAL_SCOPE } from '../registry';
import type { BridgeTransport, ConnectResult, JsDispatcher } from '../transport';

function makeMockNitro(): BridgeTransport & {
  _writes: CallEnvelope[];
  _nativeObserve: (cb: (v: unknown) => void) => void;
} {
  const writes: CallEnvelope[] = [];
  const store = new Map<string, unknown>();
  const observers = new Set<(v: unknown) => void>();
  const k = (e: { contractId: string; member: string }) => `${e.contractId}|${e.member}`;
  const t2: BridgeTransport & {
    _writes: CallEnvelope[];
    _nativeObserve: (cb: (v: unknown) => void) => void;
  } = {
    _writes: writes,
    _nativeObserve(cb) {
      observers.add(cb);
    },
    connect(_d: JsDispatcher): ConnectResult {
      return { epoch: 1, snapshot: [] };
    },
    async invoke(): Promise<ResultEnvelope> {
      return { ok: true, value: null };
    },
    invokeSync(): ResultEnvelope {
      return { ok: true, value: null };
    },
    openStream(): string {
      return 's';
    },
    closeStream(): void {},
    emitFromJs(): void {},
    endFromJs(): void {},
    stateRead(env: CallEnvelope): ResultEnvelope {
      return { ok: true, value: store.get(k(env)) };
    },
    stateObserve(): string {
      return 'o';
    },
    stateUnobserve(): void {},
    stateWrite(env: CallEnvelope): ResultEnvelope {
      writes.push({ ...env });
      if (env.op === 'stateWrite') {
        const payload = env.payload as { v: unknown } | undefined;
        store.set(k(env), payload ? payload.v : undefined);
        for (const cb of observers) cb(payload ? payload.v : undefined);
      }
      return { ok: true };
    },
    pushProviderState(contractId, scope, key, value): void {
      this.stateWrite({
        op: 'stateWrite',
        contractId,
        member: key,
        scope,
        payload: { v: value },
        correlationId: '',
        epoch: 1,
      });
    },
    announceProvided(contractId, scope): void {
      this.stateWrite({
        op: 'provide',
        contractId,
        member: '',
        scope,
        correlationId: '',
        epoch: 1,
      });
    },
    announceUnprovided(contractId, scope): void {
      this.stateWrite({
        op: 'unprovide',
        contractId,
        member: '',
        scope,
        correlationId: '',
        epoch: 1,
      });
    },
  };
  return t2;
}

const C = defineContract('nitro.dblclose.lifecycle.test', {
  state: { count: State(t.number(), 0) },
});

describe('regression (Nitro): stale double-close does not corrupt live provider B', () => {
  it('stale a.close emits no writes and native store still holds B value', () => {
    const transport = makeMockNitro();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const nativeSeen: unknown[] = [];
    transport._nativeObserve((v) => nativeSeen.push(v));

    const a = bk.provide(
      C as import('../../contract/contract').BridgeContract<unknown>,
      {},
      { scope: GLOBAL_SCOPE },
    );
    a.setState('count', 1);
    a.close('final'); // legit unprovide of A

    const b = bk.provide(
      C as import('../../contract/contract').BridgeContract<unknown>,
      {},
      { scope: GLOBAL_SCOPE },
    );
    b.setState('count', 99);

    // sanity: native saw 99 from B
    expect(nativeSeen[nativeSeen.length - 1]).toBe(99);

    // STALE second close of A (already dead at registry level)
    transport._writes.length = 0;
    a.close('final');

    // 1. A dead handle must NOT emit any write for B-owned key.
    expect(transport._writes.length).toBe(0);
    // 2. Native store for B-owned key must still be 99.
    expect(
      transport.stateRead({
        op: 'stateRead',
        contractId: C.descriptor.id,
        member: 'count',
        scope: GLOBAL_SCOPE,
        payload: undefined,
        correlationId: '',
        epoch: 1,
      }),
    ).toEqual({ ok: true, value: 99 });
    // 3. Native consumer must NOT have been told undefined.
    expect(nativeSeen[nativeSeen.length - 1]).toBe(99);
  });
});
