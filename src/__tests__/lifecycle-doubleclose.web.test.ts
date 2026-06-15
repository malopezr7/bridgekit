// Regression: stale double-close of a superseded provider must NOT corrupt the live provider's state.
// C-3: capture wasLive=binding.isLive before originalClose; gate side-effects on it.
import { describe, expect, test } from '@jest/globals';
import { defineContract, t } from '../contract/contract';
import { State } from '../contract/markers';
import { BridgeKitJs } from '../runtime/bridgekit';
import { LoopbackTransport } from '../runtime/loopbackTransport';
import { GLOBAL_SCOPE } from '../runtime/registry';

const C = defineContract('bridgekit.dblclose.lifecycle.test', {
  state: { count: State(t.number(), 0) },
});

describe('regression: stale double-close does not corrupt live provider', () => {
  test('staleObserve: observer retains live provider value after stale A.close', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    // Provider A provides + setState(1)
    const a = bk.provide(C, {}, { scope: GLOBAL_SCOPE });
    a.setState('count', 1);

    // A.close('final') — legit unprovide
    a.close('final');

    // Provider B re-provides SAME (contractId, scope) + setState(99)
    const b = bk.provide(C, {}, { scope: GLOBAL_SCOPE });
    b.setState('count', 99);

    // Observe directly on the transport
    const seen: unknown[] = [];
    transport.stateObserve(
      {
        op: 'stateObserve',
        contractId: C.descriptor.id,
        member: 'count',
        scope: GLOBAL_SCOPE,
        payload: undefined,
        correlationId: '',
        epoch: 1,
      },
      (v) => seen.push(v),
    );

    // STALE second A.close('final') fires (StrictMode / defensive double-close)
    a.close('final');

    // Correct behavior: observer must still hold 99 (B's value, not undefined from stale A).
    expect(seen[seen.length - 1]).toBe(99);
    // B must still be provided.
    expect(bk.isProvided(C)).toBe(true);
  });

  test('stateRead: store holds live provider value after stale A.close', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const a = bk.provide(C, {}, { scope: GLOBAL_SCOPE });
    a.setState('count', 1);
    a.close('final');
    const b = bk.provide(C, {}, { scope: GLOBAL_SCOPE });
    b.setState('count', 99);

    // stale close — must be silent
    a.close('final');

    const res = transport.stateRead({
      op: 'stateRead',
      contractId: C.descriptor.id,
      member: 'count',
      scope: GLOBAL_SCOPE,
      payload: undefined,
      correlationId: '',
      epoch: 1,
    });
    expect(res).toEqual({ ok: true, value: 99 });
  });
});
