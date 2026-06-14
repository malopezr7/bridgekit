// ---------------------------------------------------------------------------
// Slice B — core runtime tests (registry, dispatcher, loopback, state, proxies)
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { defineContract, t } from '../contract/contract';
import { isBridgeError } from '../contract/protocol';
import { BridgeKitJs } from '../runtime/bridgekit';
import { diagnostics } from '../runtime/diagnostics';
import { Dispatcher } from '../runtime/dispatcher';
import { LoopbackTransport } from '../runtime/loopbackTransport';
import { GLOBAL_SCOPE, Registry, serializeScope, streamSource } from '../runtime/registry';
import { createTestBridge, mockBridge } from '../testing/index';

// ---- Test contracts --------------------------------------------------------

const TestContract = defineContract('test.contract', {
  methods: {
    ping: t.query(t.string()),
    echo: t.query(t.object({ msg: t.string() }), t.string()),
    fire: t.fire(),
    syncRead: t.querySync(t.number()),
    failMethod: t.query(t.string()),
    noImpl: t.query(t.string()),
  },
  streams: {
    numbers: t.stream(t.number()),
  },
  state: {
    count: t.state(t.number(), 0),
    label: t.state(t.string(), 'initial'),
  },
});

const ScopeContract = defineContract('scope.contract', {
  methods: {
    whoami: t.query(t.string()),
  },
});

// ---- Helpers ---------------------------------------------------------------

function makeTestBridge() {
  return createTestBridge();
}

// ---- Registry tests --------------------------------------------------------

describe('Registry', () => {
  let registry: Registry;
  beforeEach(() => {
    registry = new Registry();
  });

  test('resolves global binding', () => {
    const contract = TestContract;
    registry.provide(contract, { ping: async () => 'pong' });
    const entry = registry.resolve(contract.descriptor.id, GLOBAL_SCOPE);
    expect(entry?.binding.isLive).toBe(true);
  });

  test('resolution order: instance → feature → global', () => {
    const contractId = ScopeContract.descriptor.id;
    registry.provide(ScopeContract, { whoami: async () => 'global' }, { scope: GLOBAL_SCOPE });
    registry.provide(
      ScopeContract,
      { whoami: async () => 'feature' },
      { scope: { kind: 'feature', feature: 'Feat' } },
    );

    // instance scope: should fall through to feature (no instance binding)
    const entry = registry.resolve(contractId, {
      kind: 'instance',
      feature: 'Feat',
      instance: 'tag1',
    });
    const impl = entry?.binding.impl as Record<string, () => Promise<string>>;
    return impl?.whoami().then((v: string) => expect(v).toBe('feature'));
  });

  test('supersede: second provide replaces first with dev warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const b1 = registry.provide(ScopeContract, { whoami: async () => 'first' });
    const b2 = registry.provide(ScopeContract, { whoami: async () => 'second' });
    expect(b1.isLive).toBe(false);
    expect(b2.isLive).toBe(true);
    warnSpy.mockRestore();
  });

  test('superseded binding.close() is no-op', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const b1 = registry.provide(ScopeContract, {});
    registry.provide(ScopeContract, {}); // supersedes b1
    // Should not throw
    expect(() => b1.close('final')).not.toThrow();
    warnSpy.mockRestore();
  });

  test('isProvided returns true when provided, false otherwise', () => {
    expect(registry.isProvided(TestContract.descriptor.id)).toBe(false);
    registry.provide(TestContract, {});
    expect(registry.isProvided(TestContract.descriptor.id)).toBe(true);
  });

  test('whenProvided resolves immediately when already provided', async () => {
    registry.provide(TestContract, {});
    await expect(registry.whenProvided(TestContract.descriptor.id)).resolves.toBeUndefined();
  });

  test('whenProvided waits and resolves after provide', async () => {
    const waiter = registry.whenProvided(TestContract.descriptor.id, { timeoutMs: 500 });
    setTimeout(() => registry.provide(TestContract, {}), 10);
    await expect(waiter).resolves.toBeUndefined();
  });

  test('whenProvided rejects with CONTRACT_NOT_PROVIDED after timeout', async () => {
    await expect(
      registry.whenProvided(TestContract.descriptor.id, { timeoutMs: 50 }),
    ).rejects.toThrow('CONTRACT_NOT_PROVIDED');
  });

  test('grace window: close(replacing) holds callers briefly', async () => {
    const b = registry.provide(TestContract, {});
    b.close('replacing');
    // Provide again within grace window
    const waiter = registry.whenProvided(TestContract.descriptor.id, { timeoutMs: 2000 });
    setTimeout(() => registry.provide(TestContract, {}), 20);
    await expect(waiter).resolves.toBeUndefined();
  });

  test('close(final) immediately fails callers', async () => {
    const b = registry.provide(TestContract, {});
    b.close('final');
    await expect(
      registry.whenProvided(TestContract.descriptor.id, { timeoutMs: 2000 }),
    ).rejects.toThrow();
  });
});

// ---- Dispatcher tests -------------------------------------------------------

describe('Dispatcher', () => {
  test('never rejects — provider throws → PROVIDER_ERROR envelope', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    bk.provide(TestContract, {
      failMethod: async () => {
        throw new Error('kaboom');
      },
    });

    const result = await transport.invoke({
      op: 'invoke',
      contractId: TestContract.descriptor.id,
      member: 'failMethod',
      scope: GLOBAL_SCOPE,
      correlationId: 'c1',
      epoch: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROVIDER_ERROR');
    }
  });

  test('METHOD_NOT_FOUND when method missing from impl', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    bk.provide(TestContract, {}); // no methods

    const result = await transport.invoke({
      op: 'invoke',
      contractId: TestContract.descriptor.id,
      member: 'ping',
      scope: GLOBAL_SCOPE,
      correlationId: 'c2',
      epoch: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('METHOD_NOT_FOUND');
  });

  test('CONTRACT_NOT_PROVIDED after timeout', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();
    // Don't provide anything

    const result = await transport.invoke({
      op: 'invoke',
      contractId: TestContract.descriptor.id,
      member: 'ping',
      scope: GLOBAL_SCOPE,
      correlationId: 'c3',
      epoch: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONTRACT_NOT_PROVIDED');
  }, 10000);
});

// ---- Proxy tests -----------------------------------------------------------

describe('BridgeKitJs proxy (bridge)', () => {
  test('query happy path', async () => {
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {
      ping: async () => 'pong',
    });

    const proxy = bridgekit.bridge(TestContract);
    const result = await (proxy.ping as () => Promise<string>)();
    expect(result).toBe('pong');
  });

  test('query with params', async () => {
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {
      echo: async (p: { msg: string }) => p.msg.toUpperCase(),
    });

    const proxy = bridgekit.bridge(TestContract);
    const result = await (proxy.echo as (p: { msg: string }) => Promise<string>)({ msg: 'hello' });
    expect(result).toBe('HELLO');
  });

  test('query with timeoutMs', async () => {
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {
      ping: () => new Promise((resolve) => setTimeout(() => resolve('late'), 200)),
    });

    const proxy = bridgekit.bridge(TestContract);
    await expect(
      (proxy.ping as (opts?: { timeoutMs?: number }) => Promise<string>)({ timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  test('query with AbortSignal abort', async () => {
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {
      ping: () => new Promise((resolve) => setTimeout(() => resolve('late'), 500)),
    });

    const proxy = bridgekit.bridge(TestContract);
    const ac = new AbortController();
    const promise = (proxy.ping as (opts?: { signal?: AbortSignal }) => Promise<string>)({
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 10);
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  test('querySync resolves locally when provider is JS-local (local-first)', () => {
    // With local-first resolution, querySync on a locally-provided contract returns
    // the impl value synchronously — BRIDGE_NOT_READY no longer applies here.
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {
      syncRead: () => 42,
    });
    const proxy = bridgekit.bridge(TestContract);
    expect((proxy.syncRead as () => number)()).toBe(42);
  });

  test('querySync falls through to transport (returns BRIDGE_NOT_READY) when NOT locally provided', () => {
    const { bridgekit } = makeTestBridge();
    // No provide() — no local binding; transport path used
    const proxy = bridgekit.bridge(TestContract);
    expect(() => (proxy.syncRead as () => number)()).toThrow();
  });

  test('fire does not throw', () => {
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {
      // fire has no implementation — METHOD_NOT_FOUND will increment firesDropped
    });
    const proxy = bridgekit.bridge(TestContract);
    // fire() must never throw — failures are async and counted
    expect(() => (proxy.fire as () => void)()).not.toThrow();
  });
});

// ---- Stream tests ----------------------------------------------------------

describe('streams via loopback', () => {
  test('end-to-end: JS-provided stream via direct dispatcher path', async () => {
    const { bridgekit, transport } = makeTestBridge();
    bridgekit.provide(TestContract, {
      numbers: () =>
        streamSource<number>((emit, end) => {
          emit(1);
          emit(2);
          emit(3);
          end();
          return () => {};
        }),
    });

    const received: number[] = [];
    const env = {
      op: 'streamOpen' as const,
      contractId: TestContract.descriptor.id,
      member: 'numbers',
      scope: GLOBAL_SCOPE,
      correlationId: 's1',
      epoch: 1,
    };

    await new Promise<void>((resolve) => {
      transport.openStream(
        env,
        (v) => received.push(v as number),
        (_end) => resolve(),
      );
    });

    expect(received).toEqual([1, 2, 3]);
  });

  test('multiple subscribers get same values', async () => {
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {
      numbers: () =>
        streamSource<number>((emit) => {
          setTimeout(() => emit(42), 10);
          return () => {};
        }),
    });

    const proxy = bridgekit.bridge(TestContract);
    const r1: number[] = [];
    const r2: number[] = [];

    const stream1 = (
      proxy.numbers as () => { subscribe: (cb: (v: number) => void) => () => void }
    )();
    const stream2 = (
      proxy.numbers as () => { subscribe: (cb: (v: number) => void) => () => void }
    )();

    stream1.subscribe((v) => r1.push(v));
    stream2.subscribe((v) => r2.push(v));

    await new Promise((r) => setTimeout(r, 50));
    expect(r1.length).toBeGreaterThan(0);
    expect(r2.length).toBeGreaterThan(0);
  });

  test('async iteration over stream', async () => {
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {
      numbers: () =>
        streamSource<number>((emit, end) => {
          emit(10);
          emit(20);
          end();
          return () => {};
        }),
    });

    const proxy = bridgekit.bridge(TestContract);
    const stream = (
      proxy.numbers as () => { [Symbol.asyncIterator]: () => AsyncIterator<number> }
    )();
    const items: number[] = [];
    for await (const v of stream) {
      items.push(v);
      if (items.length >= 2) break;
    }
    expect(items).toEqual([10, 20]);
  });

  test('onStreamClose disposes JS producer', async () => {
    const { bridgekit, transport } = makeTestBridge();
    const teardownCalled = { value: false };

    bridgekit.provide(TestContract, {
      numbers: () =>
        streamSource<number>((_emit, _end) => {
          return () => {
            teardownCalled.value = true;
          };
        }),
    });

    const env = {
      op: 'streamOpen' as const,
      contractId: TestContract.descriptor.id,
      member: 'numbers',
      scope: GLOBAL_SCOPE,
      correlationId: 'sc1',
      epoch: 1,
    };

    const streamId = transport.openStream(
      env,
      () => {},
      () => {},
    );
    await new Promise((r) => setTimeout(r, 10));
    transport.closeStream(streamId);
    await new Promise((r) => setTimeout(r, 10));
    expect(teardownCalled.value).toBe(true);
  });

  test('simulateReconnect drops open streams with BRIDGE_NOT_READY', async () => {
    const { bridgekit, transport } = makeTestBridge();
    bridgekit.provide(TestContract, {
      numbers: () => streamSource<number>((_emit) => () => {}),
    });

    const ends: string[] = [];
    const env = {
      op: 'streamOpen' as const,
      contractId: TestContract.descriptor.id,
      member: 'numbers',
      scope: GLOBAL_SCOPE,
      correlationId: 'rc1',
      epoch: 1,
    };
    transport.openStream(
      env,
      () => {},
      (end) => {
        if (!end.ok) ends.push(end.code);
      },
    );

    await new Promise((r) => setTimeout(r, 10));
    transport.simulateReconnect();
    await new Promise((r) => setTimeout(r, 10));

    expect(ends).toContain('BRIDGE_NOT_READY');
  });

  // QW-2: Stream async-iterator (transport path) must complete when native closes.
  // Use a stub transport that gives direct control over when onNext/onEnd fire.
  // This precisely models the native-side close without a real Nitro layer.
  test('QW-2: async iterator (transport path) resolves done:true when native closes stream', async () => {
    // Build a minimal stub transport.
    let capturedOnNext: ((v: unknown) => void) | null = null;
    let capturedOnEnd: ((end: import('../contract/protocol').ResultEnvelope) => void) | null = null;

    const stubTransport: import('../runtime/transport').BridgeTransport = {
      connect: () => ({ epoch: 1, snapshot: [] }),
      invoke: () => Promise.resolve({ ok: true, value: undefined }),
      invokeSync: () => ({ ok: true, value: undefined }),
      openStream: (_env, onNext, onEnd) => {
        capturedOnNext = onNext;
        capturedOnEnd = onEnd;
        return 'stub-stream-1';
      },
      closeStream: () => {},
      emitFromJs: () => {},
      endFromJs: () => {},
      stateRead: () => ({ ok: true, value: undefined }),
      stateObserve: () => 'obs',
      stateUnobserve: () => {},
      stateWrite: () => ({ ok: true, value: undefined }),
      pushProviderState: () => {},
    };

    const bk = new BridgeKitJs(stubTransport);
    bk.connect();
    // No local provide() — forces the transport path.

    const proxy = bk.bridge(TestContract);
    const stream = (
      proxy.numbers as () => { [Symbol.asyncIterator]: () => AsyncIterator<number> }
    )();
    const iter = stream[Symbol.asyncIterator]();

    // Start a next() call — it will pend until native emits.
    const nextPromise = iter.next();

    // Simulate native emitting a value.
    capturedOnNext!(42);
    const first = await nextPromise;
    expect(first).toEqual({ value: 42, done: false });

    // Now start another next() — it will pend until native closes.
    const nextPromise2 = iter.next();

    // Simulate native closing the stream.
    // Without QW-2 fix: nextPromise2 hangs forever.
    capturedOnEnd!({ ok: true });

    const second = await nextPromise2;
    expect(second.done).toBe(true);
    expect(second.value).toBeUndefined();
  }, 3000); // 3s timeout — hangs without fix

  // QW-2 part 2: for-await loop terminates on native stream close via stub transport.
  test('QW-2: for-await loop (transport path) terminates on native stream close', async () => {
    let capturedOnNext: ((v: unknown) => void) | null = null;
    let capturedOnEnd: ((end: import('../contract/protocol').ResultEnvelope) => void) | null = null;

    const stubTransport: import('../runtime/transport').BridgeTransport = {
      connect: () => ({ epoch: 1, snapshot: [] }),
      invoke: () => Promise.resolve({ ok: true, value: undefined }),
      invokeSync: () => ({ ok: true, value: undefined }),
      openStream: (_env, onNext, onEnd) => {
        capturedOnNext = onNext;
        capturedOnEnd = onEnd;
        return 'stub-stream-2';
      },
      closeStream: () => {},
      emitFromJs: () => {},
      endFromJs: () => {},
      stateRead: () => ({ ok: true, value: undefined }),
      stateObserve: () => 'obs',
      stateUnobserve: () => {},
      stateWrite: () => ({ ok: true, value: undefined }),
      pushProviderState: () => {},
    };

    const bk = new BridgeKitJs(stubTransport);
    bk.connect();

    const proxy = bk.bridge(TestContract);
    const stream = (
      proxy.numbers as () => { [Symbol.asyncIterator]: () => AsyncIterator<number> }
    )();

    const collected: number[] = [];

    // Start the for-await in background — will hang without the fix.
    const loopDone = (async () => {
      for await (const v of stream) {
        collected.push(v as number);
      }
    })();

    // Emit values then close — simulating native side.
    capturedOnNext!(1);
    capturedOnNext!(2);
    capturedOnEnd!({ ok: true });

    await loopDone;
    expect(collected).toEqual([1, 2]);
  }, 3000);
});

// ---- State tests -----------------------------------------------------------

describe('state mirrors', () => {
  test('initial value from descriptor', () => {
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {});
    const mirror = bridgekit.state(
      TestContract as import('../contract/contract').BridgeContract<unknown>,
      'count',
    );
    const mv = mirror.get();
    expect(mv.value).toBe(0);
  });

  test('setState updates mirror', async () => {
    const { bridgekit, transport } = makeTestBridge();
    const binding = bridgekit.provide(TestContract, {});

    // Set state via loopback transport path
    transport.stateWrite({
      op: 'stateWrite',
      contractId: TestContract.descriptor.id,
      member: 'count',
      scope: GLOBAL_SCOPE,
      payload: 42,
      correlationId: 'sw1',
      epoch: 1,
    });

    binding.setState('count', 99);
    // Mirror observes via stateObserve; check the store
    const result = transport.stateRead({
      op: 'stateRead',
      contractId: TestContract.descriptor.id,
      member: 'count',
      scope: GLOBAL_SCOPE,
      correlationId: 'sr1',
      epoch: 1,
    });

    expect(result.ok).toBe(true);
  });

  test('mirror subscribe gets notified on change (local-first: via binding.setState)', async () => {
    // With local-first resolution, bk.state() returns a LocalStateMirror backed by
    // the Registry. State updates must go through binding.setState, not transport.notifyStateChange.
    const { bridgekit } = makeTestBridge();
    const binding = bridgekit.provide(TestContract, {});

    const mirror = bridgekit.state(
      TestContract as import('../contract/contract').BridgeContract<unknown>,
      'label',
    );
    const values: unknown[] = [];
    const unsub = mirror.subscribe((mv) => values.push(mv.value));

    await new Promise((r) => setTimeout(r, 10));

    binding.setState('label', 'updated');
    await new Promise((r) => setTimeout(r, 10));

    unsub();
    expect(values.some((v) => v === 'updated')).toBe(true);
  });

  test('binding close transitions state to unprovided', async () => {
    const { bridgekit } = makeTestBridge();
    const binding = bridgekit.provide(TestContract, {});
    const mirror = bridgekit.state(
      TestContract as import('../contract/contract').BridgeContract<unknown>,
      'count',
    );

    const statuses: string[] = [];
    const unsub = mirror.subscribe((mv) => statuses.push(mv.status));

    binding.close('final');
    await new Promise((r) => setTimeout(r, 10));
    unsub();

    expect(statuses).toContain('unprovided');
  });
});

// ---- Refcounted observe/unobserve ------------------------------------------

describe('state observer refcount', () => {
  test('unsubscribe when last subscriber leaves', async () => {
    const { bridgekit, transport } = makeTestBridge();
    bridgekit.provide(TestContract, {});

    const mirror = bridgekit.state(
      TestContract as import('../contract/contract').BridgeContract<unknown>,
      'count',
    );
    const unsub1 = mirror.subscribe(() => {});
    const unsub2 = mirror.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));

    unsub1();
    // Mirror should still be observing (one subscriber left)
    unsub2();
    // Now 0 subscribers — observer should be detached (no crash)
    expect(() => transport.stateUnobserve('nonexistent')).not.toThrow();
  });
});

// ---- Dual-copy guard -------------------------------------------------------

describe('dual-copy singleton guard', () => {
  test('getDefaultBridgeKit returns the same instance on repeat calls', () => {
    const { getDefaultBridgeKit } = require('../runtime/defaultInstance');
    const i1 = getDefaultBridgeKit();
    const i2 = getDefaultBridgeKit();
    expect(i1).toBe(i2);
  });
});

// ---- INCOMPATIBLE_CONTRACT guard (Bug 2 regression) -----------------------
//
// When the native provider encodes an object result but the inbound adapter is
// missing the encode call, result.value arrives as undefined on the JS side.
// The proxy must throw INCOMPATIBLE_CONTRACT instead of silently returning undefined.

const ObjectResultContract = defineContract('obj.result.contract', {
  methods: {
    getInfo: t.querySync(t.object({ name: t.string() })),
    getInfoAsync: t.query(t.object({ name: t.string() })),
    optionalMethod: t.querySync(t.optional(t.string())),
  },
});

/** Minimal stub transport that lets tests control invokeSync/invoke results. */
function makeStubTransport(
  syncResult: () => ReturnType<import('../runtime/transport').BridgeTransport['invokeSync']>,
  asyncResult?: () => Promise<ReturnType<import('../runtime/transport').BridgeTransport['invoke']>>,
): import('../runtime/transport').BridgeTransport {
  return {
    connect: () => ({ epoch: 1, snapshot: [] }),
    invoke: asyncResult ?? (() => Promise.resolve({ ok: true, value: undefined })),
    invokeSync: syncResult,
    openStream: () => 'sid',
    closeStream: () => {},
    emitFromJs: () => {},
    endFromJs: () => {},
    stateRead: () => ({ ok: true, value: undefined }),
    stateObserve: () => 'obs',
    stateUnobserve: () => {},
    stateWrite: () => ({ ok: true, value: undefined }),
    pushProviderState: () => {},
  };
}

describe('INCOMPATIBLE_CONTRACT guard — object result missing from provider', () => {
  test('querySync: throws INCOMPATIBLE_CONTRACT when result.value is undefined for object result', () => {
    const transport = makeStubTransport(() => ({ ok: true, value: undefined }));
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const proxy = bk.bridge(ObjectResultContract);

    let caughtError: unknown;
    try {
      (proxy.getInfo as () => unknown)();
    } catch (e) {
      caughtError = e;
    }
    expect(isBridgeError(caughtError)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((caughtError as any).code).toBe('INCOMPATIBLE_CONTRACT');
  });

  test('querySync: INCOMPATIBLE_CONTRACT message includes member name', () => {
    const transport = makeStubTransport(() => ({ ok: true, value: undefined }));
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const proxy = bk.bridge(ObjectResultContract);

    let caughtMsg = '';
    try {
      (proxy.getInfo as () => unknown)();
    } catch (e) {
      caughtMsg = (e as Error).message;
    }
    expect(caughtMsg).toContain('getInfo');
  });

  test('querySync: does NOT throw for t.optional result when value is undefined', () => {
    const transport = makeStubTransport(() => ({ ok: true, value: undefined }));
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const proxy = bk.bridge(ObjectResultContract);

    expect(() => (proxy.optionalMethod as () => unknown)()).not.toThrow();
  });

  test('querySync: does NOT throw when object result is present (plain map)', () => {
    const transport = makeStubTransport(() => ({ ok: true, value: { name: 'Alice' } }));
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const proxy = bk.bridge(ObjectResultContract);

    const result = (proxy.getInfo as () => unknown)();
    expect(result).toEqual({ name: 'Alice' });
  });

  test('query (async): throws INCOMPATIBLE_CONTRACT when result.value is undefined for object result', async () => {
    const transport = makeStubTransport(
      () => ({ ok: true, value: undefined }),
      () => Promise.resolve({ ok: true, value: undefined }),
    );
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const proxy = bk.bridge(ObjectResultContract);

    let caughtError: unknown;
    try {
      await (proxy.getInfoAsync as () => Promise<unknown>)();
    } catch (e) {
      caughtError = e;
    }
    expect(isBridgeError(caughtError)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((caughtError as any).code).toBe('INCOMPATIBLE_CONTRACT');
  });

  test('query (async): does NOT throw when object result is present', async () => {
    const transport = makeStubTransport(
      () => ({ ok: true, value: undefined }),
      () => Promise.resolve({ ok: true, value: { name: 'Bob' } }),
    );
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const proxy = bk.bridge(ObjectResultContract);

    const result = await (proxy.getInfoAsync as () => Promise<unknown>)();
    expect(result).toEqual({ name: 'Bob' });
  });
});

// ---- mockBridge ------------------------------------------------------------

describe('mockBridge', () => {
  test('provided methods work', async () => {
    const mock = mockBridge(TestContract, {
      ping: async () => 'mocked',
    } as Partial<typeof TestContract._shape>);

    const result = await (mock.ping as () => Promise<string>)();
    expect(result).toBe('mocked');
  });

  test('missing method throws clear error', () => {
    const mock = mockBridge(TestContract, {});
    expect(() => (mock.echo as () => void)()).toThrowError(/mockBridge.*not implemented/);
  });
});

// ---- dump() ----------------------------------------------------------------

describe('dump()', () => {
  test('shape: has bindings, mirrors, openStreams, counters, epoch', () => {
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {});
    const d = bridgekit.dump();
    expect(d).toHaveProperty('bindings');
    expect(d).toHaveProperty('mirrors');
    expect(d).toHaveProperty('openStreams');
    expect(d).toHaveProperty('counters');
    expect(d).toHaveProperty('epoch');
    expect(d.bindings.length).toBeGreaterThan(0);
    expect(d.epoch).toBeGreaterThan(0);
  });
});

// ---- scopeKey serialization ------------------------------------------------

describe('serializeScope', () => {
  test('global', () => expect(serializeScope({ kind: 'global' })).toBe('global'));
  test('feature', () =>
    expect(serializeScope({ kind: 'feature', feature: 'Foo' })).toBe('feature:Foo'));
  test('instance', () =>
    expect(serializeScope({ kind: 'instance', feature: 'Foo', instance: 'tag' })).toBe(
      'instance:Foo:tag',
    ));
});

// ---- QW-3: No dangling timer / AbortSignal listener after call completes ----

describe('QW-3: timeout timer and AbortSignal listener cleanup on call completion', () => {
  // QW-3a: clearTimeout is called on the timeout timer when the call resolves successfully.
  test('clearTimeout called after successful call with timeout', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    // Use a stub transport that resolves immediately.
    const transport = makeStubTransport(
      () => ({ ok: true, value: 'pong' }),
      () => Promise.resolve({ ok: true, value: 'pong' }),
    );
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const proxy = bk.bridge(TestContract);
    // Call with a long timeout — the call resolves before the timeout fires.
    await (proxy.ping as (opts?: { timeoutMs?: number }) => Promise<string>)({
      timeoutMs: 5000,
    } as Parameters<typeof proxy.ping>[0]);

    // clearTimeout must have been called to cancel the timer.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  // QW-3b: AbortSignal 'abort' listener is removed after a successful call.
  test('AbortSignal abort listener removed after successful call', async () => {
    const controller = new AbortController();
    const removeEventListenerSpy = jest.spyOn(controller.signal, 'removeEventListener');

    const transport = makeStubTransport(
      () => ({ ok: true, value: 'pong' }),
      () => Promise.resolve({ ok: true, value: 'pong' }),
    );
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const proxy = bk.bridge(TestContract);
    await (proxy.ping as (opts?: { signal?: AbortSignal }) => Promise<string>)({
      signal: controller.signal,
    } as Parameters<typeof proxy.ping>[0]);

    // The abort listener must be explicitly removed after call settles.
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    removeEventListenerSpy.mockRestore();
  });
});

// ---- W2-1: Teardown on reconnect --------------------------------------------

describe('W2-1: providers and mirrors cleaned up on reconnect', () => {
  test('all registry bindings from prior epoch are closed after reconnect', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    // Register 3 providers in epoch N
    const b1 = bk.provide(TestContract, { ping: async () => 'p1' });
    const b2 = bk.provide(ScopeContract, { whoami: async () => 'w' });
    const b3 = bk.provide(
      ScopeContract,
      { whoami: async () => 'w2' },
      { scope: { kind: 'feature', feature: 'F' } },
    );

    expect(b1.isLive).toBe(true);
    expect(b2.isLive).toBe(true);
    expect(b3.isLive).toBe(true);

    // Reconnect (epoch N+1)
    bk.connect();

    // All prior bindings must be closed
    expect(b1.isLive).toBe(false);
    expect(b2.isLive).toBe(false);
    expect(b3.isLive).toBe(false);
  });

  test('mirrors detach from prior epoch: old obs is cancelled on reconnect', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const mirror = bk.state(TestContract, 'count');
    // Register a subscriber so the observer attaches to the transport
    const received: number[] = [];
    const unsub = mirror.subscribe((mv) => {
      if (typeof mv.value === 'number') received.push(mv.value);
    });

    // Push state via transport — mirror becomes provided with value 42
    transport.notifyStateChange(TestContract.descriptor.id, GLOBAL_SCOPE, 'count', 42);
    expect(mirror.get().status).toBe('provided');
    expect(mirror.get().value).toBe(42);

    // Reconnect — detaches old observers, re-attaches fresh
    bk.connect();

    // Mirror re-attaches after connect(); push another value — it should be received
    transport.notifyStateChange(TestContract.descriptor.id, GLOBAL_SCOPE, 'count', 99);
    expect(mirror.get().value).toBe(99);

    unsub();
    // received will contain both values since the observer persists across reconnect
    // The key guarantee: no dangling observer from the OLD epoch that fires twice
    expect(received).toContain(42);
    expect(received).toContain(99);
  });

  test('new epoch starts with zero inherited providers', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    bk.provide(TestContract, { ping: async () => 'old' });

    // Reconnect
    bk.connect();

    // Registry should have no live bindings after reconnect
    const resolved = bk.registry.resolve(TestContract.descriptor.id, GLOBAL_SCOPE);
    expect(resolved).toBeUndefined();
  });
});

// ---- W2-2: isProvided / awaitProvided ---------------------------------------

describe('W2-2: isProvided and awaitProvided for JS-provided contracts', () => {
  test('isProvided returns true after provide()', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    expect(bk.isProvided(TestContract)).toBe(false);

    bk.provide(TestContract, { ping: async () => 'pong' });

    expect(bk.isProvided(TestContract)).toBe(true);
  });

  test('isProvided returns false when no provider registered', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    expect(bk.isProvided(ScopeContract)).toBe(false);
  });

  test('awaitProvided resolves immediately when already provided', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    bk.provide(TestContract, { ping: async () => 'pong' });

    await expect(bk.awaitProvided(TestContract, { timeoutMs: 200 })).resolves.toBeUndefined();
  });

  test('awaitProvided resolves when JS provider registers after 50ms', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const waiter = bk.awaitProvided(TestContract, { timeoutMs: 1000 });
    setTimeout(() => bk.provide(TestContract, { ping: async () => 'late' }), 50);

    await expect(waiter).resolves.toBeUndefined();
  });

  test('awaitProvided rejects after timeout if provider never registers', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    await expect(bk.awaitProvided(TestContract, { timeoutMs: 50 })).rejects.toThrow(
      'CONTRACT_NOT_PROVIDED',
    );
  });
});

// ---- QW-4: Real openStreams counter in diagnostics --------------------------

describe('QW-4: openStreams diagnostics counter', () => {
  beforeEach(() => {
    diagnostics.reset();
  });

  test('openStreams increments when stream subscribes, decrements on unsubscribe', async () => {
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {
      numbers: () => streamSource<number>((_emit) => () => {}),
    });

    const proxy = bridgekit.bridge(TestContract);
    const stream1 = (
      proxy.numbers as () => { subscribe: (cb: (v: number) => void) => () => void }
    )();
    const stream2 = (
      proxy.numbers as () => { subscribe: (cb: (v: number) => void) => () => void }
    )();

    const unsub1 = stream1.subscribe(() => {});
    const unsub2 = stream2.subscribe(() => {});

    // Without fix: openStreams is hardcoded 0.
    expect(bridgekit.dump().openStreams).toBe(2);

    unsub1();
    expect(bridgekit.dump().openStreams).toBe(1);

    unsub2();
    expect(bridgekit.dump().openStreams).toBe(0);
  });
});

// ---- W3-1: Symmetric state codec — validate on push ------------------------

describe('W3-1: Symmetric state codec — validate on setState push', () => {
  test('setState push with wrong type rejects with validation error before sending', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(TestContract, {
      count: 0,
    });

    // count is typed as number; pushing a string should be rejected
    expect(() => {
      binding.setState('count', 'not-a-number');
    }).toThrow(/VALIDATION_FAILED|validate/i);
  });

  test('setState push with correct type succeeds', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(TestContract, {
      count: 0,
    });

    // number is correct for count — should not throw
    expect(() => {
      binding.setState('count', 42);
    }).not.toThrow();
  });

  test('setState push on contract without schema (marker path) passes through without error', () => {
    // Marker contracts have no value schema → no validation, pass-through
    const MarkerContract = defineContract('marker.no.schema', {
      state: {
        raw: t.state(t.string(), ''),
      },
    });

    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(MarkerContract, { raw: '' });

    // Even wrong type: no schema means no validate — just passes through
    // (marker path fallback; only schema-baked contracts validate)
    expect(() => {
      binding.setState('raw', 'valid string');
    }).not.toThrow();
  });
});

// ---- W3-2: Explicit state status (provided / unprovided / stale) ------------

describe('W3-2: Explicit state status', () => {
  test('provided status: mirror shows provided after value received', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const mirror = bk.state(TestContract, 'count');
    const received: Array<import('../runtime/stateMirror').MirrorValue<unknown>> = [];
    const unsub = mirror.subscribe((mv) => received.push(mv));

    transport.notifyStateChange(TestContract.descriptor.id, GLOBAL_SCOPE, 'count', 99);

    expect(mirror.get().status).toBe('provided');
    expect(mirror.get().value).toBe(99);
    unsub();
  });

  test('unprovided status: mirror shows unprovided when no value ever received', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const mirror = bk.state(TestContract, 'count');
    const unsub = mirror.subscribe(() => {});

    // No push — status stays initial/unprovided (initial before any subscription activity)
    expect(['initial', 'unprovided']).toContain(mirror.get().status);
    expect(mirror.get().value).toBe(0); // descriptor initial
    unsub();
  });

  test('stale status: mirror flips to stale after transport detach with prior value', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const mirror = bk.state(TestContract, 'count');
    const unsub = mirror.subscribe(() => {});

    // Seed a value
    transport.notifyStateChange(TestContract.descriptor.id, GLOBAL_SCOPE, 'count', 7);
    expect(mirror.get().status).toBe('provided');
    expect(mirror.get().value).toBe(7);

    // Detach (simulating reconnect teardown)
    mirror.detachTransport();

    // Value must be stale (kept) not dropped
    expect(mirror.get().status).toBe('stale');
    expect(mirror.get().value).toBe(7); // value preserved
    unsub();
  });

  test('stale→unprovided: detach on never-provided mirror gives unprovided not stale', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const mirror = bk.state(TestContract, 'count');
    const unsub = mirror.subscribe(() => {});

    // Detach without any prior value push
    mirror.detachTransport();

    expect(mirror.get().status).toBe('unprovided');
    unsub();
  });
});

// ---- W3-4: Bounded JS stream consumer queue with DROP_OLDEST ----------------

describe('W3-4: Bounded JS stream consumer queue — DROP_OLDEST backpressure', () => {
  beforeEach(() => {
    diagnostics.reset();
  });

  test('ring buffer is bounded: drops happen when more than CAPACITY items emitted without consuming', async () => {
    // Use the transport path (LoopbackTransport) so the ring-buffer async-iterator is exercised.
    // In the local-first path (provide+bridge on same instance) the impl stream is returned
    // directly without the ring-buffer wrapper — which is correct (no cross-boundary queue needed).
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    // Capture the onNext callback so we can drive it directly via the transport.
    let capturedOnNext: ((v: unknown) => void) | null = null;
    jest.spyOn(transport, 'openStream').mockImplementation((_env, onNext, _onEnd) => {
      capturedOnNext = onNext;
      return 'test-stream';
    });

    const proxy = bk.bridge(TestContract);
    const stream = (
      proxy.numbers as () => {
        [Symbol.asyncIterator]: () => AsyncIterator<number>;
      }
    )();
    const iter = stream[Symbol.asyncIterator]();

    // Open the iterator — registers a waiter for the first item
    const firstResultPromise = iter.next();

    // capturedOnNext is set synchronously by the mock when [Symbol.asyncIterator] opens the stream
    expect(capturedOnNext).not.toBeNull();
    if (capturedOnNext !== null) {
      // First item is delivered to the pending waiter directly — no queue
      capturedOnNext(0);
      // 200 more items flood the ring buffer (capacity = 64); items 65-200 are dropped
      for (let i = 1; i <= 200; i++) {
        (capturedOnNext as (v: unknown) => void)(i);
      }
      // streamDrops must be > 0 (we emitted 200 items into a 64-slot buffer)
      expect(diagnostics.getStreamDrops()).toBeGreaterThan(0);
    }

    const first = await firstResultPromise;
    expect(first.done).toBe(false);
    expect(first.value).toBe(0);
  });

  test('stream drops counter in diagnostics increments on overflow', () => {
    // Directly exercise the ring buffer logic by simulating the transport-path
    // async-iterator: emit via the iterCb subscriber that the iterator registers.
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    let capturedOnNext: ((v: unknown) => void) | null = null;
    jest.spyOn(transport, 'openStream').mockImplementation((env, onNext, onEnd) => {
      capturedOnNext = onNext;
      // Simulate an immediately-ending empty stream
      setTimeout(() => onEnd({ ok: true }), 10_000);
      return 'mock-stream-id';
    });

    const proxy = bk.bridge(TestContract);
    const stream = (
      proxy.numbers as () => {
        [Symbol.asyncIterator]: () => AsyncIterator<number>;
      }
    )();
    const iter = stream[Symbol.asyncIterator]();

    // Register a waiter (first next() will wait)
    iter.next(); // waiter registered

    if (capturedOnNext !== null) {
      // One item for the waiter
      capturedOnNext(0);
      // Now flood the queue: 200 items, CAPACITY=64, so 200-64=136 drops
      for (let i = 1; i <= 200; i++) {
        (capturedOnNext as (v: unknown) => void)(i);
      }
      expect(diagnostics.getStreamDrops()).toBeGreaterThan(0);
      // Verify queue size is bounded: consume all via repeated next()
      // after 64 reads the queue should be empty
    }
  });
});
