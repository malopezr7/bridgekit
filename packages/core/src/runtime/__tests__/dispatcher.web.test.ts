import { describe, expect, test } from '@jest/globals';
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
  },
});

function makeStreamOpen(member: string, flags?: Pick<CallEnvelope, 'latestOnly' | 'sticky'>) {
  return {
    op: 'streamOpen' as const,
    contractId: StreamDeliveryContract.descriptor.id,
    member,
    scope: GLOBAL_SCOPE,
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
});
