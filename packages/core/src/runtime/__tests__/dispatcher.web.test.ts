import { describe, expect, jest, test } from '@jest/globals';
import { defineContract, t } from '../../contract/contract';
import type { CallEnvelope, ResultEnvelope } from '../../contract/protocol';
import { BridgeKitJs } from '../bridgekit';
import { Dispatcher } from '../dispatcher';
import { GLOBAL_SCOPE, Registry, streamSource } from '../registry';
import type { BridgeTransport, ConnectResult, JsDispatcher } from '../transport';

const StreamDeliveryContract = defineContract('dispatcher.stream.delivery', {
  streams: {
    latestEvents: { kind: 'stream', value: t.string(), latestOnly: true },
    stickyEvents: { kind: 'stream', value: t.string(), sticky: true },
    plainEvents: { kind: 'stream', value: t.string() },
    paramEvents: {
      kind: 'stream',
      value: t.string(),
      params: t.object({ id: t.number() }),
      latestOnly: true,
    },
    objectEvents: { kind: 'stream', value: t.json(), latestOnly: true },
  },
});

function makeStreamOpen(
  member: string,
  flags?: Pick<CallEnvelope, 'latestOnly' | 'sticky'>,
  payload?: unknown,
  scope: CallEnvelope['scope'] = GLOBAL_SCOPE,
) {
  return {
    op: 'streamOpen' as const,
    contractId: StreamDeliveryContract.descriptor.id,
    member,
    scope,
    ...(payload !== undefined ? { payload } : {}),
    correlationId: `corr-${member}`,
    epoch: 1,
    ...flags,
  } satisfies CallEnvelope;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeDispatcherHarness() {
  const registry = new Registry();
  const dispatcher = new Dispatcher(
    registry,
    new Map([[StreamDeliveryContract.descriptor.id, StreamDeliveryContract]]),
  );
  const values = new Map<string, unknown[]>();
  const ends = new Map<string, ResultEnvelope[]>();

  const transport = {
    emitFromJs(streamId: string, value: unknown): void {
      values.set(streamId, [...(values.get(streamId) ?? []), value]);
    },
    endFromJs(streamId: string, end: ResultEnvelope): void {
      ends.set(streamId, [...(ends.get(streamId) ?? []), end]);
    },
  } as BridgeTransport;

  dispatcher.setTransport(transport);
  return { dispatcher, ends, registry, values };
}

describe('Dispatcher stream delivery modes', () => {
  test('late subscriber receives latest item for latestOnly streamOpen', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    let sequence = 0;
    registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          sequence += 1;
          emit(`item-${sequence}`);
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();
    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-2');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['item-1']);
    expect(values.get('stream-2')).toEqual(['item-1', 'item-2']);
  });

  test('sticky late subscriber receives latest item as latestOnly alias', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    let sequence = 0;
    registry.provide(StreamDeliveryContract, {
      stickyEvents: () =>
        streamSource<string>((emit) => {
          sequence += 1;
          emit(`sticky-${sequence}`);
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('stickyEvents', { sticky: true }), 'stream-1');
    await flushMicrotasks();
    dispatcher.onStreamOpen(makeStreamOpen('stickyEvents', { sticky: true }), 'stream-2');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['sticky-1']);
    expect(values.get('stream-2')).toEqual(['sticky-1', 'sticky-2']);
  });

  test('plain stream does not replay prior items to late subscriber', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    let sequence = 0;
    registry.provide(StreamDeliveryContract, {
      plainEvents: () =>
        streamSource<string>((emit) => {
          sequence += 1;
          emit(`plain-${sequence}`);
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('plainEvents'), 'stream-1');
    await flushMicrotasks();
    dispatcher.onStreamOpen(makeStreamOpen('plainEvents'), 'stream-2');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['plain-1']);
    expect(values.get('stream-2')).toEqual(['plain-2']);
  });

  test('parked latestOnly stream replays latest item after replacement retry', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    const oldBinding = registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          emit('old-latest');
          return () => {};
        }),
    });
    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();

    oldBinding.close('replacing');
    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-2');
    await flushMicrotasks();
    expect(values.get('stream-2')).toBeUndefined();

    registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          emit('replacement-live');
          return () => {};
        }),
    });
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['old-latest']);
    expect(values.get('stream-2')).toEqual(['old-latest', 'replacement-live']);
  });

  test('ok-terminal latestOnly stream does not replay terminal generation to a new subscriber', async () => {
    const { dispatcher, ends, registry, values } = makeDispatcherHarness();
    let sequence = 0;
    registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit, end) => {
          sequence += 1;
          emit(`terminal-${sequence}`);
          end({ ok: true });
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();
    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-2');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['terminal-1']);
    expect(values.get('stream-2')).toEqual(['terminal-2']);
    expect(ends.get('stream-1')).toEqual([{ ok: true }]);
    expect(ends.get('stream-2')).toEqual([{ ok: true }]);
  });

  test('error-terminal latestOnly stream does not replay failed generation to a new subscriber', async () => {
    const { dispatcher, ends, registry, values } = makeDispatcherHarness();
    let sequence = 0;
    registry.provide(StreamDeliveryContract, {
      latestEvents: () => ({
        [Symbol.asyncIterator](): AsyncIterator<string> {
          let emitted = false;
          return {
            next(): Promise<IteratorResult<string>> {
              if (!emitted) {
                emitted = true;
                sequence += 1;
                return Promise.resolve({ done: false, value: `error-${sequence}` });
              }
              return Promise.reject(new Error('boom'));
            },
          };
        },
      }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();
    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-2');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['error-1']);
    expect(values.get('stream-2')).toEqual(['error-2']);
    expect(ends.get('stream-1')).toEqual([
      expect.objectContaining({ ok: false, code: 'PROVIDER_ERROR' }),
    ]);
    expect(ends.get('stream-2')).toEqual([
      expect.objectContaining({ ok: false, code: 'PROVIDER_ERROR' }),
    ]);
  });

  test('final-close then re-provide does not replay the old provider generation', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    const firstBinding = registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          emit('provider-generation-1');
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();
    firstBinding.close('final');
    registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          emit('provider-generation-2');
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-2');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['provider-generation-1']);
    expect(values.get('stream-2')).toEqual(['provider-generation-2']);
  });

  test('close with omitted reason invalidates latest replay before re-provide', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    const firstBinding = registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          emit('noreason-gen1');
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();
    firstBinding.close();
    registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          emit('noreason-gen2');
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-2');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['noreason-gen1']);
    expect(values.get('stream-2')).toEqual(['noreason-gen2']);
  });

  test("replacing hot-swap cycles don't retain stale replay generation tokens", async () => {
    const { dispatcher, registry } = makeDispatcherHarness();
    const getLiveReplayGenerationCount = () =>
      (dispatcher as unknown as { _liveReplayGenerations: Set<unknown> })._liveReplayGenerations
        .size;
    const getLatestReplayEntryCount = () =>
      (dispatcher as unknown as { _streamLatestValues: Map<string, unknown> })._streamLatestValues
        .size;

    let binding = registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          emit('swap-gen-0');
          return () => {};
        }),
    });
    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-0');
    await flushMicrotasks();

    for (let cycle = 1; cycle <= 40; cycle += 1) {
      binding.close('replacing');
      binding = registry.provide(StreamDeliveryContract, {
        latestEvents: () =>
          streamSource<string>((emit) => {
            emit(`swap-gen-${cycle}`);
            return () => {};
          }),
      });
      dispatcher.onStreamOpen(
        makeStreamOpen('latestEvents', { latestOnly: true }),
        `stream-${cycle}`,
      );
      await flushMicrotasks();
    }

    expect(getLatestReplayEntryCount()).toBe(1);
    expect(getLiveReplayGenerationCount()).toBeLessThanOrEqual(getLatestReplayEntryCount() + 1);
  });

  test('final-close of fallback provider invalidates requested-scope replay', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    const instanceScope: CallEnvelope['scope'] = {
      kind: 'instance',
      feature: 'fallback-feature',
      instance: 'fallback-instance',
    };
    const firstBinding = registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          emit('fallback-generation-1');
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(
      makeStreamOpen('latestEvents', { latestOnly: true }, undefined, instanceScope),
      'stream-1',
    );
    await flushMicrotasks();
    firstBinding.close('final');
    registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          emit('fallback-generation-2');
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(
      makeStreamOpen('latestEvents', { latestOnly: true }, undefined, instanceScope),
      'stream-2',
    );
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['fallback-generation-1']);
    expect(values.get('stream-2')).toEqual(['fallback-generation-2']);
  });

  test('post-final-close producer emissions stay live but cannot re-poison replay', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    let emitFromFirst: ((value: string) => void) | undefined;
    const firstBinding = registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          emitFromFirst = emit;
          emit('gen1-a');
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();
    firstBinding.close('final');
    emitFromFirst?.('gen1-late');
    await flushMicrotasks();
    registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          emit('gen2-b');
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-2');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['gen1-a', 'gen1-late']);
    expect(values.get('stream-2')).toEqual(['gen2-b']);
  });

  test('envelope latestOnly updates replay cache for unflagged descriptors', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    let sequence = 0;
    registry.provide(StreamDeliveryContract, {
      plainEvents: () =>
        streamSource<string>((emit) => {
          sequence += 1;
          emit(`envelope-${sequence}`);
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('plainEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();
    dispatcher.onStreamOpen(makeStreamOpen('plainEvents', { latestOnly: true }), 'stream-2');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['envelope-1']);
    expect(values.get('stream-2')).toEqual(['envelope-1', 'envelope-2']);
  });

  test('envelope sticky updates replay cache for unflagged descriptors', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    let sequence = 0;
    registry.provide(StreamDeliveryContract, {
      plainEvents: () =>
        streamSource<string>((emit) => {
          sequence += 1;
          emit(`sticky-envelope-${sequence}`);
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('plainEvents', { sticky: true }), 'stream-1');
    await flushMicrotasks();
    dispatcher.onStreamOpen(makeStreamOpen('plainEvents', { sticky: true }), 'stream-2');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['sticky-envelope-1']);
    expect(values.get('stream-2')).toEqual(['sticky-envelope-1', 'sticky-envelope-2']);
  });

  test('closing one same-key subscriber keeps replay cache for live siblings', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    let sequence = 0;
    registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          sequence += 1;
          emit(`shared-${sequence}`);
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();
    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-2');
    await flushMicrotasks();
    dispatcher.onStreamClose('stream-1', 'consumer');
    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-3');
    await flushMicrotasks();

    expect(values.get('stream-2')).toEqual(['shared-1', 'shared-2']);
    expect(values.get('stream-3')).toEqual(['shared-2', 'shared-3']);
  });

  test('clone failures never fail stream open and fall back to JSON replay clone', async () => {
    const originalStructuredClone = globalThis.structuredClone;
    Object.defineProperty(globalThis, 'structuredClone', {
      configurable: true,
      value: jest.fn(() => {
        throw new Error('cannot clone symbol');
      }),
    });
    const { dispatcher, ends, registry, values } = makeDispatcherHarness();
    try {
      registry.provide(StreamDeliveryContract, {
        objectEvents: () =>
          streamSource<unknown>((emit) => {
            emit({ marker: Symbol('not-cloneable'), safe: 'ok' });
            return () => {};
          }),
      });

      dispatcher.onStreamOpen(makeStreamOpen('objectEvents', { latestOnly: true }), 'stream-1');
      await flushMicrotasks();
      dispatcher.onStreamOpen(makeStreamOpen('objectEvents', { latestOnly: true }), 'stream-2');
      await flushMicrotasks();

      expect(values.get('stream-2')?.[0]).toEqual({ safe: 'ok' });
      expect(ends.get('stream-2')).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, 'structuredClone', {
        configurable: true,
        value: originalStructuredClone,
      });
    }
  });

  test('closeAllProducers clears latest replay across epochs', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    let sequence = 0;
    registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          sequence += 1;
          emit(`epoch-${sequence}`);
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();
    dispatcher.closeAllProducers();
    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-2');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['epoch-1']);
    expect(values.get('stream-2')).toEqual(['epoch-2']);
  });

  test('latest replay cache is partitioned by stream params', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    registry.provide(StreamDeliveryContract, {
      paramEvents: (params: { id: number }) =>
        streamSource<string>((emit) => {
          emit(`data-for-${params.id}`);
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(
      makeStreamOpen('paramEvents', { latestOnly: true }, { id: 1 }),
      'stream-1',
    );
    await flushMicrotasks();
    dispatcher.onStreamOpen(
      makeStreamOpen('paramEvents', { latestOnly: true }, { id: 2 }),
      'stream-2',
    );
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['data-for-1']);
    expect(values.get('stream-2')).toEqual(['data-for-2']);
  });

  test('descriptor delivery mode updates latest cache for plain streamOpen envelopes', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    let sequence = 0;
    registry.provide(StreamDeliveryContract, {
      latestEvents: () =>
        streamSource<string>((emit) => {
          sequence += 1;
          emit(`descriptor-${sequence}`);
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();
    dispatcher.onStreamOpen(makeStreamOpen('latestEvents'), 'stream-2');
    await flushMicrotasks();
    dispatcher.onStreamOpen(makeStreamOpen('latestEvents', { latestOnly: true }), 'stream-3');
    await flushMicrotasks();

    expect(values.get('stream-1')).toEqual(['descriptor-1']);
    expect(values.get('stream-2')).toEqual(['descriptor-1', 'descriptor-2']);
    expect(values.get('stream-3')).toEqual(['descriptor-2', 'descriptor-3']);
  });

  test('replayed latest value is cloned rather than aliased', async () => {
    const { dispatcher, registry, values } = makeDispatcherHarness();
    const emitted = { nested: { count: 1 } };
    registry.provide(StreamDeliveryContract, {
      objectEvents: () =>
        streamSource<unknown>((emit) => {
          emit(emitted);
          return () => {};
        }),
    });

    dispatcher.onStreamOpen(makeStreamOpen('objectEvents', { latestOnly: true }), 'stream-1');
    await flushMicrotasks();
    dispatcher.onStreamOpen(makeStreamOpen('objectEvents', { latestOnly: true }), 'stream-2');
    await flushMicrotasks();

    const first = values.get('stream-1')?.[0];
    const replayed = values.get('stream-2')?.[0];
    expect(replayed).toEqual(first);
    expect(Object.is(replayed, first)).toBe(false);
  });

  test('transport stream forwards descriptor delivery flags', () => {
    let capturedEnv: CallEnvelope | undefined;
    const transport: BridgeTransport = {
      connect(_dispatcher: JsDispatcher): ConnectResult {
        return { epoch: 7, snapshot: [] };
      },
      invoke: () => Promise.resolve({ ok: true }),
      invokeSync: () => ({ ok: true }),
      openStream(env: CallEnvelope): string {
        capturedEnv = env;
        return 'stream-1';
      },
      closeStream: () => {},
      emitFromJs: () => {},
      endFromJs: () => {},
      stateRead: () => ({ ok: true }),
      stateObserve: () => 'obs-1',
      stateUnobserve: () => {},
      stateWrite: () => ({ ok: true }),
      pushProviderState: () => {},
      announceProvided: () => {},
      announceUnprovided: () => {},
    };
    const bridgekit = new BridgeKitJs(transport);
    bridgekit.connect();
    const proxy = bridgekit.bridge(StreamDeliveryContract);

    proxy.latestEvents().subscribe(() => {});

    expect(capturedEnv).toEqual(expect.objectContaining({ latestOnly: true }));
    expect(capturedEnv).not.toHaveProperty('sticky');
  });

  test('transport stream forwards sticky descriptor flag', () => {
    let capturedEnv: CallEnvelope | undefined;
    const transport: BridgeTransport = {
      connect(_dispatcher: JsDispatcher): ConnectResult {
        return { epoch: 7, snapshot: [] };
      },
      invoke: () => Promise.resolve({ ok: true }),
      invokeSync: () => ({ ok: true }),
      openStream(env: CallEnvelope): string {
        capturedEnv = env;
        return 'stream-1';
      },
      closeStream: () => {},
      emitFromJs: () => {},
      endFromJs: () => {},
      stateRead: () => ({ ok: true }),
      stateObserve: () => 'obs-1',
      stateUnobserve: () => {},
      stateWrite: () => ({ ok: true }),
      pushProviderState: () => {},
      announceProvided: () => {},
      announceUnprovided: () => {},
    };
    const bridgekit = new BridgeKitJs(transport);
    bridgekit.connect();
    const proxy = bridgekit.bridge(StreamDeliveryContract);

    proxy.stickyEvents().subscribe(() => {});

    expect(capturedEnv).toEqual(expect.objectContaining({ sticky: true }));
    expect(capturedEnv).not.toHaveProperty('latestOnly');
  });
});
