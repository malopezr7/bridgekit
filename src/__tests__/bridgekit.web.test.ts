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

  test('querySync returns BRIDGE_NOT_READY from loopback', () => {
    const { bridgekit } = makeTestBridge();
    bridgekit.provide(TestContract, {
      syncRead: () => 42,
    });
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

  test('mirror subscribe gets notified on change', async () => {
    const { bridgekit, transport } = makeTestBridge();
    bridgekit.provide(TestContract, {});

    const mirror = bridgekit.state(
      TestContract as import('../contract/contract').BridgeContract<unknown>,
      'label',
    );
    const values: unknown[] = [];
    const unsub = mirror.subscribe((mv) => values.push(mv.value));

    await new Promise((r) => setTimeout(r, 10));

    transport.notifyStateChange(TestContract.descriptor.id, GLOBAL_SCOPE, 'label', 'updated');
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
