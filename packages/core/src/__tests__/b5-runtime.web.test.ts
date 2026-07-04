// ---------------------------------------------------------------------------
// B5 runtime hardening tests — WU-6
//
// 5.7: dispatcher._openProducers leak in catch: after stream source throws
//      mid-iteration, the streamId must be removed from _openProducers so
//      onStreamClose does NOT attempt a second unsubscribe/endFromJs.
// 5.8: registry.ts grace dead-code: pendingCallers is never populated before
//      close('replacing') fires. Confirm graceTimer.unref?.() is called on
//      node.js (prevents test-runner hang).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { defineContract, t } from '../contract/contract';
import { BridgeKitJs } from '../runtime/bridgekit';
import type { Dispatcher } from '../runtime/dispatcher';
import { LoopbackTransport } from '../runtime/loopbackTransport';
import { GLOBAL_SCOPE, Registry, streamSource } from '../runtime/registry';

// ---- Shared contract -------------------------------------------------------

const StreamContract = defineContract('b5.stream.contract', {
  methods: {},
  streams: {
    items: t.stream(t.string()),
  },
  state: {},
});

const GraceContract = defineContract('b5.grace.contract', {
  methods: {
    ping: t.query(t.string()),
  },
  streams: {
    events: t.stream(t.string()),
  },
  state: {
    count: t.state(t.number(), 0),
  },
});

const FallbackGraceContract = defineContract('b5.grace.fallback', {
  methods: {
    ping: t.query(t.string()),
  },
  state: {},
});

const INSTANCE_SCOPE = { kind: 'instance' as const, feature: 'checkout', instance: 'cart-1' };
const FEATURE_SCOPE = { kind: 'feature' as const, feature: 'checkout' };

function invokePing(transport: LoopbackTransport, contractId = GraceContract.descriptor.id) {
  return transport.invoke({
    op: 'invoke',
    contractId,
    member: 'ping',
    scope: GLOBAL_SCOPE,
    correlationId: `corr-${contractId}-${Date.now()}`,
    epoch: transport.currentEpoch,
  });
}

function invokePingInScope(
  transport: LoopbackTransport,
  scope: typeof GLOBAL_SCOPE | typeof FEATURE_SCOPE | typeof INSTANCE_SCOPE,
  contractId = FallbackGraceContract.descriptor.id,
) {
  return transport.invoke({
    op: 'invoke',
    contractId,
    member: 'ping',
    scope,
    correlationId: `corr-${contractId}-${Date.now()}`,
    epoch: transport.currentEpoch,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---- 5.7 Dispatcher _openProducers leak ------------------------------------

/**
 * A custom BridgeStreamSource that immediately throws from the async iterator's
 * next() call, simulating a provider-side error mid-pump.
 */
function makeThrowingStream(
  error: Error,
): import('../contract/contract').BridgeStreamSource<string> {
  return {
    subscribe(_cb: (v: string) => void): () => void {
      return () => {};
    },
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        async next(): Promise<IteratorResult<string>> {
          throw error;
        },
        async return(): Promise<IteratorResult<string>> {
          return { value: undefined as unknown as string, done: true };
        },
      };
    },
  };
}

describe('5.7 dispatcher: _openProducers cleaned up after stream source throws', () => {
  let transport: LoopbackTransport;
  let bk: BridgeKitJs;

  beforeEach(() => {
    transport = new LoopbackTransport();
    bk = new BridgeKitJs(transport);
    bk.connect();
  });

  afterEach(() => {
    try {
      bk.disconnect('final');
    } catch {
      /* ignore */
    }
  });

  test('after stream source throws mid-iteration, _openProducers entry is deleted', async () => {
    // Provide a stream that throws on first next()
    bk.provide(StreamContract, {
      items: () => makeThrowingStream(new Error('stream error')),
    });

    let transportStreamId = '';
    let endReceived = false;

    await new Promise<void>((resolve) => {
      // openStream returns the transport-generated streamId used as the _openProducers key
      transportStreamId = transport.openStream(
        {
          op: 'streamOpen' as const,
          contractId: StreamContract.descriptor.id,
          member: 'items',
          scope: GLOBAL_SCOPE,
          correlationId: 'corr-5-7-a',
          epoch: 1,
        },
        () => {},
        (_end) => {
          endReceived = true;
          resolve();
        },
      );
    });

    expect(endReceived).toBe(true);
    expect(transportStreamId).toBeTruthy();

    // Access private field via cast — test-only
    const dispatcher = (bk as unknown as { _dispatcher: Dispatcher })._dispatcher;
    const openProducers = (dispatcher as unknown as { _openProducers: Map<string, unknown> })
      ._openProducers;

    // KEY ASSERTION: the entry must be gone after the pump catch fires endFromJs
    expect(openProducers.has(transportStreamId)).toBe(false);
  });

  test('after stream source throws, onStreamClose for same id is a safe no-op', async () => {
    bk.provide(StreamContract, {
      items: () => makeThrowingStream(new Error('boom')),
    });

    let transportStreamId = '';

    await new Promise<void>((resolve) => {
      transportStreamId = transport.openStream(
        {
          op: 'streamOpen' as const,
          contractId: StreamContract.descriptor.id,
          member: 'items',
          scope: GLOBAL_SCOPE,
          correlationId: 'corr-5-7-b',
          epoch: 1,
        },
        () => {},
        () => resolve(),
      );
    });

    const dispatcher = (bk as unknown as { _dispatcher: Dispatcher })._dispatcher;

    // After pump inner-catch fires, the entry is gone. Calling onStreamClose for the
    // same id must be a no-op (entry check: if (producer) guard).
    expect(() => dispatcher.onStreamClose(transportStreamId, 'test')).not.toThrow();
    // onStreamClose should NOT find the entry — it was already cleaned up
    // We verify by checking the map is still empty for this id after the no-op
    const openProducers2 = (dispatcher as unknown as { _openProducers: Map<string, unknown> })
      ._openProducers;
    expect(openProducers2.has(transportStreamId)).toBe(false);
  });
});

// ---- 5.8 Registry grace: graceTimer.unref?.() ------------------------------

describe('5.8 registry: graceTimer.unref() to prevent test-runner hang', () => {
  test('close(replacing) does not throw and proceeds correctly (unref?.() safe-called)', () => {
    // The graceTimer.unref?.() call uses optional chaining — it must not throw
    // even in environments where setTimeout returns a primitive (e.g. jsdom).
    // The structural fix is in registry.ts: (graceTimer as { unref?: ... }).unref?.()
    const registry = new Registry();

    const binding = registry.provide(GraceContract, { ping: async () => 'ok' });

    // Must not throw — the unref?.() optional call is safe in all environments
    expect(() => binding.close('replacing')).not.toThrow();

    // Provide again so the grace-timer callback is a no-op
    const binding2 = registry.provide(GraceContract, { ping: async () => 'ok2' });
    expect(registry.isProvided(GraceContract.descriptor.id)).toBe(true);
    binding2.close('final');
  });

  test('replacing tombstone is removed when replacement arrives before timer expiry', async () => {
    const registry = new Registry();

    const binding = registry.provide(GraceContract, { ping: async () => 'ok' });
    binding.close('replacing');
    const parked = registry.whenReplacingProvided(GraceContract.descriptor.id, GLOBAL_SCOPE);

    const binding2 = registry.provide(GraceContract, { ping: async () => 'ok2' });

    await expect(parked).resolves.toBeUndefined();
    expect(registry.isProvided(GraceContract.descriptor.id)).toBe(true);
    expect(
      registry.whenReplacingProvided(GraceContract.descriptor.id, GLOBAL_SCOPE),
    ).toBeUndefined();

    binding2.close('final');
  });
});

// ---- S5 Grace window + close semantics -------------------------------------

describe('S5 replacing grace window', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('Invoke parks then retries', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(GraceContract, { ping: async () => 'old' });
    binding.close('replacing');

    const invocation = invokePing(transport);
    let settled = false;
    invocation.finally(() => {
      settled = true;
    });

    await flushMicrotasks();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(1499);
    await flushMicrotasks();
    expect(settled).toBe(false);

    bk.provide(GraceContract, { ping: async () => 'replacement' });
    await expect(invocation).resolves.toEqual({ ok: true, value: 'replacement' });
  });

  test('Grace expires', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(GraceContract, { ping: async () => 'old' });
    binding.close('replacing');

    const invocation = invokePing(transport);
    let settled = false;
    invocation.finally(() => {
      settled = true;
    });

    jest.advanceTimersByTime(1499);
    await flushMicrotasks();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(1);
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      code: 'CONTRACT_NOT_PROVIDED',
    });
  });

  test('Parked invoke after unrelated provide rejects when replacing grace expires', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(GraceContract, { ping: async () => 'old' });
    binding.close('replacing');

    bk.provide(StreamContract, { items: () => streamSource<string>(() => () => {}) });

    let result: unknown;
    invokePing(transport).then((value) => {
      result = value;
    });

    jest.advanceTimersByTime(1500);
    await flushMicrotasks();

    expect(result).toMatchObject({
      ok: false,
      code: 'CONTRACT_NOT_PROVIDED',
    });
  });

  test('Partial wake after unrelated provide leaves remaining parked invoke to reject on grace expiry', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(FallbackGraceContract, { ping: async () => 'global-old' });
    binding.close('replacing');
    bk.provide(StreamContract, { items: () => streamSource<string>(() => () => {}) });

    let globalResult: unknown;
    const featureInvocation = invokePingInScope(transport, FEATURE_SCOPE);
    invokePingInScope(transport, GLOBAL_SCOPE).then((value) => {
      globalResult = value;
    });
    await flushMicrotasks();

    bk.provide(
      FallbackGraceContract,
      { ping: async () => 'feature-replacement' },
      { scope: FEATURE_SCOPE },
    );
    await expect(featureInvocation).resolves.toEqual({ ok: true, value: 'feature-replacement' });
    expect(globalResult).toBeUndefined();

    jest.advanceTimersByTime(1500);
    await flushMicrotasks();

    expect(globalResult).toMatchObject({
      ok: false,
      code: 'CONTRACT_NOT_PROVIDED',
    });
  });

  test('Invoke parks on instance tombstone and wakes when global fallback is provided', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const instanceBinding = bk.provide(
      FallbackGraceContract,
      { ping: async () => 'instance-old' },
      { scope: INSTANCE_SCOPE },
    );
    instanceBinding.close('replacing');

    const invocation = invokePingInScope(transport, INSTANCE_SCOPE);
    let settled = false;
    invocation.finally(() => {
      settled = true;
    });

    jest.advanceTimersByTime(200);
    await flushMicrotasks();
    expect(settled).toBe(false);

    bk.provide(FallbackGraceContract, { ping: async () => 'global-replacement' });

    await expect(invocation).resolves.toEqual({ ok: true, value: 'global-replacement' });
  });

  test('Invoke parks on global tombstone and wakes when feature fallback is provided', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const globalBinding = bk.provide(FallbackGraceContract, { ping: async () => 'global-old' });
    globalBinding.close('replacing');

    const invocation = invokePingInScope(transport, INSTANCE_SCOPE);
    let settled = false;
    invocation.finally(() => {
      settled = true;
    });

    jest.advanceTimersByTime(200);
    await flushMicrotasks();
    expect(settled).toBe(false);

    bk.provide(
      FallbackGraceContract,
      { ping: async () => 'feature-replacement' },
      { scope: FEATURE_SCOPE },
    );

    await expect(invocation).resolves.toEqual({ ok: true, value: 'feature-replacement' });
  });

  test('Parked invoke rejects at the 1500ms grace boundary', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(GraceContract, { ping: async () => 'old' });
    binding.close('replacing');

    const invocation = invokePing(transport);
    let settled = false;
    invocation.finally(() => {
      settled = true;
    });

    jest.advanceTimersByTime(1499);
    await flushMicrotasks();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(1);
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      code: 'CONTRACT_NOT_PROVIDED',
    });
  });

  test('Instance call parks behind global tombstone when no wider provider exists', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const globalBinding = bk.provide(FallbackGraceContract, { ping: async () => 'global-old' });
    globalBinding.close('replacing');

    const invocation = invokePingInScope(transport, INSTANCE_SCOPE);
    let settled = false;
    invocation.finally(() => {
      settled = true;
    });

    await flushMicrotasks();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(1500);
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      code: 'CONTRACT_NOT_PROVIDED',
    });
  });

  test('streamOpen parks then retries', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(GraceContract, {
      ping: async () => 'old',
      events: () => streamSource<string>(() => () => {}),
    });
    binding.close('replacing');

    const values: unknown[] = [];
    const ends: unknown[] = [];
    transport.openStream(
      {
        op: 'streamOpen',
        contractId: GraceContract.descriptor.id,
        member: 'events',
        scope: GLOBAL_SCOPE,
        correlationId: 'corr-s5-stream-retry',
        epoch: transport.currentEpoch,
      },
      (value) => values.push(value),
      (end) => ends.push(end),
    );

    await flushMicrotasks();
    expect(ends).toEqual([]);

    bk.provide(GraceContract, {
      ping: async () => 'replacement',
      events: () =>
        streamSource<string>((emit, end) => {
          emit('replacement-event');
          end({ ok: true });
          return () => {};
        }),
    });
    await flushMicrotasks();

    expect(values).toEqual(['replacement-event']);
    expect(ends).toEqual([{ ok: true }]);
  });

  test('streamOpen closed while parked does not subscribe after replacement', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(GraceContract, {
      ping: async () => 'old',
      events: () => streamSource<string>(() => () => {}),
    });
    binding.close('replacing');

    const values: unknown[] = [];
    const ends: unknown[] = [];
    const streamId = transport.openStream(
      {
        op: 'streamOpen',
        contractId: GraceContract.descriptor.id,
        member: 'events',
        scope: GLOBAL_SCOPE,
        correlationId: 'corr-s5-stream-cancel',
        epoch: transport.currentEpoch,
      },
      (value) => values.push(value),
      (end) => ends.push(end),
    );

    transport.closeStream(streamId);

    let subscribed = false;
    bk.provide(GraceContract, {
      ping: async () => 'replacement',
      events: () =>
        streamSource<string>((emit, end) => {
          subscribed = true;
          emit('replacement-event');
          end({ ok: true });
          return () => {};
        }),
    });
    await flushMicrotasks();

    const dispatcher = (bk as unknown as { _dispatcher: Dispatcher })._dispatcher;
    const openProducers = (dispatcher as unknown as { _openProducers: Map<string, unknown> })
      ._openProducers;
    expect(subscribed).toBe(false);
    expect(values).toEqual([]);
    expect(ends).toEqual([]);
    expect(openProducers.has(streamId)).toBe(false);
  });

  test('streamOpen grace expires', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(GraceContract, {
      ping: async () => 'old',
      events: () => streamSource<string>(() => () => {}),
    });
    binding.close('replacing');

    const ends: unknown[] = [];
    transport.openStream(
      {
        op: 'streamOpen',
        contractId: GraceContract.descriptor.id,
        member: 'events',
        scope: GLOBAL_SCOPE,
        correlationId: 'corr-s5-stream-expiry',
        epoch: transport.currentEpoch,
      },
      () => {},
      (end) => ends.push(end),
    );

    jest.advanceTimersByTime(1499);
    await flushMicrotasks();
    expect(ends).toEqual([]);

    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(ends).toEqual([expect.objectContaining({ ok: false, code: 'CONTRACT_NOT_PROVIDED' })]);
  });

  test('Resolve sees not-ready tombstone', () => {
    const registry = new Registry();
    const binding = registry.provide(GraceContract, { ping: async () => 'old' });

    binding.close('replacing');

    expect(registry.resolve(GraceContract.descriptor.id, GLOBAL_SCOPE)).toBeUndefined();
    expect(registry.isProvided(GraceContract.descriptor.id, GLOBAL_SCOPE)).toBe(false);
  });

  test('Tombstone does not block wider fallback', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    bk.provide(FallbackGraceContract, { ping: async () => 'feature' }, { scope: FEATURE_SCOPE });
    const instanceBinding = bk.provide(
      FallbackGraceContract,
      { ping: async () => 'instance' },
      { scope: INSTANCE_SCOPE },
    );
    instanceBinding.close('replacing');

    const consumer = bk.bridge(FallbackGraceContract, { scope: INSTANCE_SCOPE });
    await expect(consumer.ping()).resolves.toBe('feature');
  });

  test('In-flight invoke during reconnect parks and retries against replayed provider', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();
    bk.provide(GraceContract, { ping: async () => 'replayed' });

    let invocation: Promise<unknown> | null = null;
    const originalConnect = transport.connect.bind(transport);
    transport.connect = (dispatcher) => {
      const result = originalConnect(dispatcher);
      invocation = invokePing(transport);
      return result;
    };

    bk.connect();

    expect(invocation).not.toBeNull();
    await expect(invocation as Promise<unknown>).resolves.toEqual({
      ok: true,
      value: 'replayed',
    });
  });

  test('No wake toward dead provider', async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const invocation = invokePing(transport);
    const binding = bk.provide(GraceContract, { ping: async () => 'dead' });
    binding.close('final');

    await expect(invocation).resolves.toMatchObject({
      ok: false,
      code: 'CONTRACT_NOT_PROVIDED',
    });
  });

  test("close('final') after replacing clears tombstone and rejects parked callers immediately", async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(GraceContract, { ping: async () => 'old' });
    binding.close('replacing');

    const invocation = invokePing(transport);
    let settled = false;
    invocation.finally(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    binding.close('final');
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      code: 'CONTRACT_NOT_PROVIDED',
    });
    expect(settled).toBe(true);
  });

  test("stale superseded binding close('final') does not reject a newer replacing grace waiter", async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const staleBinding = bk.provide(GraceContract, { ping: async () => 'stale' });
    const ownerBinding = bk.provide(GraceContract, { ping: async () => 'owner' });
    ownerBinding.close('replacing');

    let result: unknown;
    const invocation = invokePing(transport).then((value) => {
      result = value;
      return value;
    });
    await flushMicrotasks();

    staleBinding.close('final');
    await flushMicrotasks();
    expect(result).toBeUndefined();

    bk.provide(GraceContract, { ping: async () => 'replacement' });
    await expect(invocation).resolves.toEqual({ ok: true, value: 'replacement' });
    expect(result).toEqual({ ok: true, value: 'replacement' });
  });

  test("stale owner of cleared tombstone cannot close('final') a newer replacing tombstone", async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const firstBinding = bk.provide(GraceContract, { ping: async () => 'first' });
    firstBinding.close('replacing');
    const secondBinding = bk.provide(GraceContract, { ping: async () => 'second' });
    secondBinding.close('replacing');

    let result: unknown;
    const invocation = invokePing(transport).then((value) => {
      result = value;
      return value;
    });
    await flushMicrotasks();

    firstBinding.close('final');
    await flushMicrotasks();
    expect(result).toBeUndefined();

    bk.provide(GraceContract, { ping: async () => 'third' });
    await expect(invocation).resolves.toEqual({ ok: true, value: 'third' });
    expect(result).toEqual({ ok: true, value: 'third' });
  });

  test("closeAll('final') clears replacing tombstones and rejects parked callers immediately", async () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(GraceContract, { ping: async () => 'old' });
    binding.close('replacing');

    const invocation = invokePing(transport);
    let settled = false;
    invocation.finally(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    bk.registry.closeAll('final');
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      code: 'CONTRACT_NOT_PROVIDED',
    });
    expect(settled).toBe(true);
  });

  test('RT-JS-20 subscribed mirror preserves lastKnown value and reflects unprovided status', () => {
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(GraceContract, { ping: async () => 'ok' });
    binding.setState('count', 7);
    const mirror = bk.state(GraceContract, 'count');
    const seen: unknown[] = [];
    const unsubscribe = mirror.subscribe((value) => seen.push(value));

    binding.close('final');

    expect(mirror.get().value).toBe(7);
    expect(mirror.get().status).toBe('unprovided');
    expect(seen).toContainEqual({ value: 7, status: 'unprovided' });
    unsubscribe();
  });
});
