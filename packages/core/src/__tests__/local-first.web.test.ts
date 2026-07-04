// ---------------------------------------------------------------------------
// H-5 — Local-first resolution tests
//
// Contract: when a JS-local provider exists, the consumer proxy (bridge()) and
// state() NEVER call the transport. When NO local provider exists, the transport
// IS used (fall-through preserved).
//
// Scenarios:
//   1. querySync — sync call, no transport
//   2. query (Async) — async call, no transport; honors timeoutMs / AbortSignal
//   3. fire (Void) — call impl, ignore result; transport never called; errors swallowed
//   4. stream — local subscription, cancellation tears down; transport never called
//   5. state — local state initial + update reflected; transport never called
//   6. Fall-through — without local provider, transport IS used
//   7. Scope: feature-scope provider resolves for feature-scope consumer
//   8. Global fallback from feature consumer without feature binding
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { defineContract, t } from '../contract/contract';
import { Async, State, Stream, Sync, Void } from '../contract/markers';
import { isBridgeError } from '../contract/protocol';
import { BridgeKitJs } from '../runtime/bridgekit';
import { GLOBAL_SCOPE, streamSource } from '../runtime/registry';
import type { BridgeTransport, ConnectResult } from '../runtime/transport';

// ---- Marker-based contract for local-first tests ----------------------------

const LocalContract = defineContract('bridgekit.local-first.test', {
  methods: {
    getMotto: Sync(t.string()),
    greet: Async(t.object({ name: t.string() }), t.string()),
    doFire: Void(t.object({ value: t.number() })),
    slowQuery: Async(t.string(), { timeoutMs: null }),
  },
  streams: {
    ticks: Stream(t.number()),
  },
  state: {
    count: State(t.number(), 0),
    label: State(t.string(), 'hello'),
  },
});

// ---- Scoped contract --------------------------------------------------------

const ScopedContract = defineContract('bridgekit.scoped.test', {
  methods: {
    who: Async(t.string()),
  },
});

// ---- Spy transport: records calls and can throw ----------------------------

function makeSpyTransport(opts?: {
  invokeResult?: unknown;
  invokeSyncResult?: unknown;
  shouldThrow?: boolean;
}): BridgeTransport & {
  invokeCalls: number;
  invokeSyncCalls: number;
  openStreamCalls: number;
  stateObserveCalls: number;
} {
  const t = {
    invokeCalls: 0,
    invokeSyncCalls: 0,
    openStreamCalls: 0,
    stateObserveCalls: 0,

    connect(): ConnectResult {
      return { epoch: 1, snapshot: [] };
    },
    invoke(): Promise<ReturnType<BridgeTransport['invoke']>> {
      t.invokeCalls++;
      if (opts?.shouldThrow) throw new Error('transport.invoke should not be called');
      return Promise.resolve(
        opts?.invokeResult !== undefined
          ? ({ ok: true, value: opts.invokeResult } as Awaited<
              ReturnType<BridgeTransport['invoke']>
            >)
          : ({ ok: true, value: 'from-transport' } as Awaited<
              ReturnType<BridgeTransport['invoke']>
            >),
      );
    },
    invokeSync(): ReturnType<BridgeTransport['invokeSync']> {
      t.invokeSyncCalls++;
      if (opts?.shouldThrow) throw new Error('transport.invokeSync should not be called');
      return { ok: true, value: opts?.invokeSyncResult ?? 'from-transport-sync' };
    },
    openStream(): string {
      t.openStreamCalls++;
      if (opts?.shouldThrow) throw new Error('transport.openStream should not be called');
      return 'stream-id';
    },
    closeStream(): void {},
    emitFromJs(): void {},
    endFromJs(): void {},
    stateRead(): ReturnType<BridgeTransport['stateRead']> {
      return { ok: true, value: 'from-transport-state' };
    },
    stateObserve(): string {
      t.stateObserveCalls++;
      if (opts?.shouldThrow) throw new Error('transport.stateObserve should not be called');
      return 'obs-id';
    },
    stateUnobserve(): void {},
    stateWrite(): ReturnType<BridgeTransport['stateWrite']> {
      return { ok: true };
    },
    pushProviderState(): void {},
    announceProvided(): void {},
    announceUnprovided(): void {},
  };
  return t;
}

// ---- Helpers ----------------------------------------------------------------

function makeBk(opts?: {
  invokeSyncResult?: unknown;
  invokeResult?: unknown;
  shouldThrow?: boolean;
}) {
  const transport = makeSpyTransport(opts);
  const bk = new BridgeKitJs(transport);
  bk.connect();
  return { bk, transport };
}

// ===========================================================================
// 1. querySync — local provider, NO transport call
// ===========================================================================

describe('local-first: querySync (Sync)', () => {
  test('returns value from local impl without calling transport.invokeSync', () => {
    const { bk, transport } = makeBk({ shouldThrow: true });
    bk.provide(LocalContract, {
      getMotto: () => 'keep it local',
    });

    const proxy = bk.bridge(LocalContract);
    const result = (proxy as Record<string, () => string>).getMotto();

    expect(result).toBe('keep it local');
    expect(transport.invokeSyncCalls).toBe(0);
  });

  test('falls through to transport when no local provider exists', () => {
    const { bk, transport } = makeBk({ invokeSyncResult: 'from-native' });
    // No provide() call

    const proxy = bk.bridge(LocalContract);
    // Transport returns BRIDGE_NOT_READY or ok:true depending on impl; we just check it was called
    try {
      (proxy as Record<string, () => string>).getMotto();
    } catch {
      // Transport may return an error envelope which proxy throws — that's fine
    }
    expect(transport.invokeSyncCalls).toBe(1);
  });
});

// ===========================================================================
// 2. query (Async) — local provider, NO transport call
// ===========================================================================

describe('local-first: query (Async)', () => {
  test('resolves from local impl without calling transport.invoke', async () => {
    const { bk, transport } = makeBk({ shouldThrow: true });
    bk.provide(LocalContract, {
      greet: async ({ name }: { name: string }) => `Hi ${name}!`,
    });

    const proxy = bk.bridge(LocalContract);
    const result = await (proxy as Record<string, (p: { name: string }) => Promise<string>>).greet({
      name: 'World',
    });

    expect(result).toBe('Hi World!');
    expect(transport.invokeCalls).toBe(0);
  });

  test('honors timeoutMs: local impl takes too long → rejects with TIMEOUT', async () => {
    const { bk } = makeBk();
    bk.provide(LocalContract, {
      slowQuery: () => new Promise((resolve) => setTimeout(() => resolve('late'), 500)),
    });

    const proxy = bk.bridge(LocalContract);
    const promise = (
      proxy as Record<string, (opts: { timeoutMs: number }) => Promise<string>>
    ).slowQuery({ timeoutMs: 50 });

    await expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  test('honors AbortSignal: aborting cancels local call with CANCELLED', async () => {
    const { bk } = makeBk();
    bk.provide(LocalContract, {
      slowQuery: () => new Promise((resolve) => setTimeout(() => resolve('late'), 500)),
    });

    const proxy = bk.bridge(LocalContract);
    const ac = new AbortController();
    const promise = (
      proxy as Record<string, (opts: { signal: AbortSignal }) => Promise<string>>
    ).slowQuery({ signal: ac.signal });
    setTimeout(() => ac.abort(), 10);

    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  test('local impl throws → rejects with PROVIDER_ERROR bridge error', async () => {
    const { bk } = makeBk();
    bk.provide(LocalContract, {
      greet: async () => {
        throw new Error('boom');
      },
    });

    const proxy = bk.bridge(LocalContract);
    const promise = (proxy as Record<string, (p: { name: string }) => Promise<string>>).greet({
      name: 'X',
    });

    await expect(promise).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  test('falls through to transport when no local provider exists', async () => {
    const { bk, transport } = makeBk({ invokeResult: 'native-greeting' });
    // No provide()

    const proxy = bk.bridge(LocalContract);
    try {
      await (proxy as Record<string, (p: { name: string }) => Promise<string>>).greet({
        name: 'X',
      });
    } catch {
      // Dispatcher may reject — we just care that invoke was called
    }
    expect(transport.invokeCalls).toBe(1);
  });
});

// ===========================================================================
// 3. fire (Void) — local provider, NO transport call; errors swallowed
// ===========================================================================

describe('local-first: fire (Void)', () => {
  test('calls local impl and returns synchronously without calling transport.invoke', async () => {
    const fired: number[] = [];
    const { bk, transport } = makeBk({ shouldThrow: true });
    bk.provide(LocalContract, {
      doFire: ({ value }: { value: number }) => {
        fired.push(value);
      },
    });

    const proxy = bk.bridge(LocalContract);
    expect(() =>
      (proxy as Record<string, (p: { value: number }) => void>).doFire({ value: 42 }),
    ).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toEqual([42]);
    expect(transport.invokeCalls).toBe(0);
  });

  test('local fire impl throws → swallowed, does not reject caller', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { bk } = makeBk();
    bk.provide(LocalContract, {
      doFire: () => {
        throw new Error('fire-explosion');
      },
    });

    const proxy = bk.bridge(LocalContract);
    expect(() =>
      (proxy as Record<string, (p: { value: number }) => void>).doFire({ value: 1 }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    warnSpy.mockRestore();
  });

  test('falls through to transport when no local provider exists', async () => {
    const { bk, transport } = makeBk();
    const proxy = bk.bridge(LocalContract);
    (proxy as Record<string, () => void>).doFire({ value: 0 } as unknown as undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.invokeCalls).toBe(1);
  });
});

// ===========================================================================
// 4. stream (Stream) — local subscription; transport never called
// ===========================================================================

describe('local-first: stream (Stream)', () => {
  test('delivers values from local provider without calling transport.openStream', async () => {
    const { bk, transport } = makeBk({ shouldThrow: true });
    bk.provide(LocalContract, {
      ticks: () =>
        streamSource<number>((emit, end) => {
          // Emit async to avoid calling unsub before subscribe() returns
          setTimeout(() => {
            emit(1);
            emit(2);
            emit(3);
            end();
          }, 0);
          return () => {};
        }),
    });

    const proxy = bk.bridge(LocalContract);
    const stream = (
      proxy as Record<string, () => { subscribe: (cb: (v: number) => void) => () => void }>
    ).ticks();

    const received: number[] = [];
    await new Promise<void>((resolve) => {
      const unsub = stream.subscribe((v) => {
        received.push(v);
        if (received.length === 3) {
          unsub();
          resolve();
        }
      });
    });

    expect(received).toEqual([1, 2, 3]);
    expect(transport.openStreamCalls).toBe(0);
  });

  test('cancellation tears down local subscription', async () => {
    let teardownCalled = false;
    const { bk } = makeBk();
    bk.provide(LocalContract, {
      ticks: () =>
        streamSource<number>((_emit, _end) => {
          return () => {
            teardownCalled = true;
          };
        }),
    });

    const proxy = bk.bridge(LocalContract);
    const stream = (
      proxy as Record<string, () => { subscribe: (cb: (v: number) => void) => () => void }>
    ).ticks();

    const unsub = stream.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    await new Promise((r) => setTimeout(r, 10));

    expect(teardownCalled).toBe(true);
  });

  test('multi-value async iteration from local stream', async () => {
    const { bk } = makeBk();
    bk.provide(LocalContract, {
      ticks: () =>
        streamSource<number>((emit, end) => {
          emit(10);
          emit(20);
          end();
          return () => {};
        }),
    });

    const proxy = bk.bridge(LocalContract);
    const stream = (proxy as Record<string, () => AsyncIterable<number>>).ticks();

    const items: number[] = [];
    for await (const v of stream) {
      items.push(v);
    }
    expect(items).toEqual([10, 20]);
  });

  test('falls through to transport when no local provider exists', async () => {
    const { bk, transport } = makeBk();
    const proxy = bk.bridge(LocalContract);
    const stream = (
      proxy as Record<string, () => { subscribe: (cb: (v: number) => void) => () => void }>
    ).ticks();
    const unsub = stream.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));
    unsub();

    expect(transport.openStreamCalls).toBe(1);
  });
});

// ===========================================================================
// 5. state — local binding; transport.stateObserve never called
// ===========================================================================

describe('local-first: state (State)', () => {
  test('initial value from local binding without calling transport.stateObserve', () => {
    const { bk, transport } = makeBk({ shouldThrow: true });
    const binding = bk.provide(LocalContract, {});

    const mirror = bk.state(
      LocalContract as unknown as import('../contract/contract').BridgeContract<unknown>,
      'count',
    );
    expect(mirror.get().value).toBe(0);
    // Subscribe — should not hit transport
    const unsub = mirror.subscribe(() => {});
    expect(transport.stateObserveCalls).toBe(0);
    unsub();
  });

  test('local state update via binding.setState reflects in mirror', async () => {
    const { bk } = makeBk();
    const binding = bk.provide(LocalContract, {});

    const mirror = bk.state(
      LocalContract as unknown as import('../contract/contract').BridgeContract<unknown>,
      'count',
    );
    const values: number[] = [];
    const unsub = mirror.subscribe((mv) => values.push(mv.value as number));

    binding.setState('count', 99);
    await new Promise((r) => setTimeout(r, 10));

    unsub();
    expect(values).toContain(99);
  });

  test('label state initial value and update', async () => {
    const { bk } = makeBk();
    const binding = bk.provide(LocalContract, {});

    const mirror = bk.state(
      LocalContract as unknown as import('../contract/contract').BridgeContract<unknown>,
      'label',
    );
    expect(mirror.get().value).toBe('hello');

    const values: string[] = [];
    const unsub = mirror.subscribe((mv) => values.push(mv.value as string));

    binding.setState('label', 'world');
    await new Promise((r) => setTimeout(r, 10));

    unsub();
    expect(values).toContain('world');
  });

  test('falls through to transport stateObserve when no local provider exists', () => {
    const { bk, transport } = makeBk();
    // No provide()
    const mirror = bk.state(
      LocalContract as unknown as import('../contract/contract').BridgeContract<unknown>,
      'count',
    );
    const unsub = mirror.subscribe(() => {});
    expect(transport.stateObserveCalls).toBe(1);
    unsub();
  });
});

// ===========================================================================
// 6. Scope resolution
// ===========================================================================

describe('local-first: scope resolution', () => {
  test('feature-scope provider resolves for feature-scope consumer', async () => {
    const { bk, transport } = makeBk({ shouldThrow: true });
    const featureScope = { kind: 'feature' as const, feature: 'myFeature' };

    bk.provide(ScopedContract, { who: async () => 'feature-impl' }, { scope: featureScope });

    const proxy = bk.bridge(ScopedContract, { scope: featureScope });
    const result = await (proxy as Record<string, () => Promise<string>>).who();

    expect(result).toBe('feature-impl');
    expect(transport.invokeCalls).toBe(0);
  });

  test('global fallback: feature consumer falls back to global provider', async () => {
    const { bk, transport } = makeBk({ shouldThrow: true });
    const globalScope = { kind: 'global' as const };
    const featureScope = { kind: 'feature' as const, feature: 'myFeature' };

    // Provide at global, consume at feature — should still resolve locally
    bk.provide(ScopedContract, { who: async () => 'global-impl' }, { scope: globalScope });

    const proxy = bk.bridge(ScopedContract, { scope: featureScope });
    const result = await (proxy as Record<string, () => Promise<string>>).who();

    expect(result).toBe('global-impl');
    expect(transport.invokeCalls).toBe(0);
  });

  test('no local provider at any scope level → falls through to transport', async () => {
    const { bk, transport } = makeBk({ invokeResult: 'native' });
    const featureScope = { kind: 'feature' as const, feature: 'noBinding' };
    // No provide()
    const proxy = bk.bridge(ScopedContract, { scope: featureScope });
    try {
      await (proxy as Record<string, () => Promise<string>>).who();
    } catch {
      // May reject — we just check transport was called
    }
    expect(transport.invokeCalls).toBe(1);
  });
});

// ===========================================================================
// 7. Readiness waiter fallback
// ===========================================================================

describe('local-first: readiness waiter scope fallback', () => {
  test('Fallback-aware waiter wakes', async () => {
    const { bk } = makeBk();
    const instanceScope = {
      kind: 'instance' as const,
      feature: 'readinessFeature',
      instance: 'instanceA',
    };
    const featureScope = { kind: 'feature' as const, feature: 'readinessFeature' };

    const waiter = bk.awaitProvided(ScopedContract, { scope: instanceScope, timeoutMs: 50 });

    bk.provide(ScopedContract, { who: async () => 'feature-ready' }, { scope: featureScope });

    await expect(waiter).resolves.toBeUndefined();
  });

  test('JS-only lookup order uses nearest fallback', async () => {
    const { bk, transport } = makeBk({ shouldThrow: true });
    const instanceScope = {
      kind: 'instance' as const,
      feature: 'lookupFeature',
      instance: 'instanceA',
    };
    const featureScope = { kind: 'feature' as const, feature: 'lookupFeature' };

    bk.provide(ScopedContract, { who: async () => 'global-impl' }, { scope: GLOBAL_SCOPE });
    bk.provide(ScopedContract, { who: async () => 'feature-impl' }, { scope: featureScope });

    const proxy = bk.bridge(ScopedContract, { scope: instanceScope });
    const result = await (proxy as Record<string, () => Promise<string>>).who();

    expect(result).toBe('feature-impl');
    expect(transport.invokeCalls).toBe(0);

    // Pin the READINESS lookup path too (not just invoke): an instance-scoped
    // readiness query must resolve via the nearest fallback provider.
    await expect(
      bk.awaitProvided(ScopedContract, { scope: instanceScope, timeoutMs: 50 }),
    ).resolves.toBeUndefined();
  });

  test('Loopback stays pure JS', async () => {
    const { bk, transport } = makeBk({ shouldThrow: true });
    const instanceScope = {
      kind: 'instance' as const,
      feature: 'loopbackFeature',
      instance: 'instanceA',
    };

    const waiter = bk.awaitProvided(ScopedContract, { scope: instanceScope, timeoutMs: 50 });

    bk.provide(ScopedContract, { who: async () => 'loopback-global' }, { scope: GLOBAL_SCOPE });

    await expect(waiter).resolves.toBeUndefined();
    expect(bk.isProvided(ScopedContract, { scope: instanceScope })).toBe(true);
    expect(transport.invokeCalls).toBe(0);
    expect(transport.invokeSyncCalls).toBe(0);
    expect(transport.openStreamCalls).toBe(0);
    expect(transport.stateObserveCalls).toBe(0);
  });

  test('does not wake waiters for unrelated scopes', async () => {
    const { bk } = makeBk();
    const waitingScope = { kind: 'feature' as const, feature: 'waitingFeature' };
    const unrelatedScope = { kind: 'feature' as const, feature: 'unrelatedFeature' };

    const waiter = bk.awaitProvided(ScopedContract, { scope: waitingScope, timeoutMs: 20 });

    bk.provide(ScopedContract, { who: async () => 'unrelated' }, { scope: unrelatedScope });

    await expect(waiter).rejects.toThrow('CONTRACT_NOT_PROVIDED');
  });
});
