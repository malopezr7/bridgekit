import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { defineContract, t } from '../../contract/contract';
import type { ResultEnvelope } from '../../contract/protocol';
import { BridgeKitJs } from '../bridgekit';
import { diagnostics } from '../diagnostics';
import { fromAsyncIterable, streamSource } from '../registry';
import type { BridgeTransport, JsDispatcher } from '../transport';

const StreamContract = defineContract('ws11.stream-terminals', {
  streams: { values: t.stream(t.number()) },
});

const JsonStreamContract = defineContract('ws11.stream-terminal-retention', {
  streams: { values: t.stream(t.json()) },
});

class ControlledTransport implements BridgeTransport {
  onNext: ((value: unknown) => void) | null = null;
  onEnd: ((end: ResultEnvelope) => void) | null = null;
  sessions: Array<{
    onNext: (value: unknown) => void;
    onEnd: (end: ResultEnvelope) => void;
  }> = [];

  connect(_dispatcher: JsDispatcher) {
    return { epoch: 1, snapshot: [], nativeProvided: [] };
  }
  invoke() {
    return Promise.resolve({ ok: true as const });
  }
  invokeSync() {
    return { ok: true as const };
  }
  openStream(
    _env: Parameters<BridgeTransport['openStream']>[0],
    onNext: (value: unknown) => void,
    onEnd: (end: ResultEnvelope) => void,
  ) {
    this.onNext = onNext;
    this.onEnd = onEnd;
    this.sessions.push({ onNext, onEnd });
    return `controlled-stream-${this.sessions.length}`;
  }
  closeStream() {}
  emitFromJs() {}
  endFromJs() {}
  stateRead() {
    return { ok: true as const };
  }
  stateObserve() {
    return 'observer';
  }
  stateUnobserve() {}
  stateWrite() {
    return { ok: true as const };
  }
  pushProviderState() {}
  announceProvided() {}
  announceUnprovided() {}
}

function createControlledStream() {
  const transport = new ControlledTransport();
  const bridgekit = new BridgeKitJs(transport);
  bridgekit.connect();
  return {
    bridgekit,
    transport,
    stream: bridgekit.bridge(StreamContract).values(),
  };
}

describe('WS-11 stream terminals', () => {
  beforeEach(() => diagnostics.reset());

  test('error terminal rejects pending and future iterator next calls exactly once', async () => {
    const { bridgekit, transport, stream } = createControlledStream();
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    const terminal = {
      ok: false as const,
      code: 'PROVIDER_ERROR' as const,
      message: 'native stream failed',
    };

    transport.onEnd?.(terminal);

    await expect(pending).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'native stream failed',
    });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    transport.onEnd?.({ ok: true });
    transport.onNext?.(42);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(bridgekit.dump().openStreams).toBe(0);
  });

  test('clean terminal finishes iterator and diagnostics only once', async () => {
    const first = createControlledStream();
    const second = createControlledStream();
    const firstIterator = first.stream[Symbol.asyncIterator]();
    const secondIterator = second.stream[Symbol.asyncIterator]();
    const pending = firstIterator.next();

    expect(diagnostics.getOpenStreams()).toBe(2);
    first.transport.onEnd?.({ ok: true });

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(diagnostics.getOpenStreams()).toBe(1);
    await firstIterator.return?.();
    expect(diagnostics.getOpenStreams()).toBe(1);
    await secondIterator.return?.();
    expect(diagnostics.getOpenStreams()).toBe(0);
  });

  test('subscribe reports an error terminal without clean completion', () => {
    const { bridgekit, transport, stream } = createControlledStream();
    const onValue = jest.fn();
    const onError = jest.fn();
    const onComplete = jest.fn();
    const unsubscribe = stream.subscribe(onValue, { onError, onComplete });

    transport.onEnd?.({
      ok: false,
      code: 'PROVIDER_ERROR',
      message: 'subscription failed',
    });
    transport.onEnd?.({ ok: true });
    transport.onNext?.(7);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PROVIDER_ERROR', message: 'subscription failed' }),
    );
    expect(onComplete).not.toHaveBeenCalled();
    expect(onValue).not.toHaveBeenCalled();
    expect(bridgekit.dump().openStreams).toBe(0);
    unsubscribe();
    expect(bridgekit.dump().openStreams).toBe(0);
  });

  test('subscribe reports clean completion without an error', () => {
    const { transport, stream } = createControlledStream();
    const values: number[] = [];
    const onError = jest.fn();
    const onComplete = jest.fn();

    stream.subscribe((value) => values.push(value), { onError, onComplete });
    transport.onNext?.(3);
    transport.onEnd?.({ ok: true });
    transport.onEnd?.({ ok: true });

    expect(values).toEqual([3]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(diagnostics.getOpenStreams()).toBe(0);
  });

  test('throwing terminal subscriber cannot block peers or iterator settlement', async () => {
    const { transport, stream } = createControlledStream();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const throwingOnError = jest.fn(() => {
      throw new Error('observer failed');
    });
    const peerOnError = jest.fn();
    stream.subscribe(() => {}, { onError: throwingOnError });
    stream.subscribe(() => {}, { onError: peerOnError });
    const pending = stream[Symbol.asyncIterator]().next();

    expect(() =>
      transport.onEnd?.({
        ok: false,
        code: 'PROVIDER_ERROR',
        message: 'native stream failed',
      }),
    ).not.toThrow();

    expect(throwingOnError).toHaveBeenCalledTimes(1);
    expect(peerOnError).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(diagnostics.getOpenStreams()).toBe(0);
    expect(diagnostics.getCounters().errors).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('local stream completion notifies subscriber and closes diagnostics', () => {
    const transport = new ControlledTransport();
    const bridgekit = new BridgeKitJs(transport);
    bridgekit.connect();
    bridgekit.provide(StreamContract, {
      values: () =>
        streamSource<number>((emit, end) => {
          emit(1);
          end({ ok: true });
          return () => {};
        }),
    });
    const onComplete = jest.fn();

    bridgekit
      .bridge(StreamContract)
      .values()
      .subscribe(() => {}, { onComplete });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(diagnostics.getOpenStreams()).toBe(0);
  });

  test('local stream error notifies subscriber', () => {
    const transport = new ControlledTransport();
    const bridgekit = new BridgeKitJs(transport);
    bridgekit.connect();
    bridgekit.provide(StreamContract, {
      values: () =>
        streamSource<number>((_emit, end) => {
          end({ ok: false, code: 'PROVIDER_ERROR' });
          return () => {};
        }),
    });
    const onError = jest.fn();

    bridgekit
      .bridge(StreamContract)
      .values()
      .subscribe(() => {}, { onError });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
    expect(diagnostics.getOpenStreams()).toBe(0);
  });

  test('fromAsyncIterable reports completion and errors', async () => {
    let resolveComplete!: () => void;
    let resolveError!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });
    const errored = new Promise<void>((resolve) => {
      resolveError = resolve;
    });
    const onComplete = jest.fn(resolveComplete);
    const onError = jest.fn(resolveError);
    const failingIterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new Error('iterable failed')),
        };
      },
    };
    fromAsyncIterable(
      (async function* () {
        yield 1;
      })(),
    ).subscribe(() => {}, { onComplete });
    fromAsyncIterable(failingIterable).subscribe(() => {}, { onError });

    await Promise.all([completed, errored]);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PROVIDER_ERROR', message: 'iterable failed' }),
    );
  });

  test('stale terminal from a closed session cannot settle its replacement', () => {
    const { transport, stream } = createControlledStream();
    const firstUnsubscribe = stream.subscribe(() => {});
    const firstSession = transport.sessions[0];
    firstUnsubscribe();
    const values: number[] = [];
    const onComplete = jest.fn();
    stream.subscribe((value) => values.push(value), { onComplete });
    const secondSession = transport.sessions[1];

    firstSession?.onEnd({ ok: true });
    secondSession?.onNext(9);

    expect(values).toEqual([9]);
    expect(onComplete).not.toHaveBeenCalled();
    secondSession?.onEnd({ ok: true });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  test('fresh accessor opens a new transport session after completion', () => {
    const { bridgekit, transport, stream } = createControlledStream();
    stream.subscribe(() => {});
    transport.sessions[0]?.onEnd({ ok: true });
    const values: number[] = [];

    bridgekit
      .bridge(StreamContract)
      .values()
      .subscribe((value) => values.push(value));
    transport.sessions[1]?.onNext(11);

    expect(transport.sessions).toHaveLength(2);
    expect(values).toEqual([11]);
  });

  test('iterator created after settlement does not open diagnostics', () => {
    const { transport, stream } = createControlledStream();
    stream.subscribe(() => {});
    transport.sessions[0]?.onEnd({ ok: true });

    stream[Symbol.asyncIterator]();

    expect(diagnostics.getOpenStreams()).toBe(0);
  });

  test('next after iterator return cannot drain buffered values', async () => {
    const { transport, stream } = createControlledStream();
    const iterator = stream[Symbol.asyncIterator]();
    transport.sessions[0]?.onNext(5);

    await iterator.return?.();

    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  test('error terminal releases buffered values', async () => {
    if (global.gc === undefined) return;
    const transport = new ControlledTransport();
    const bridgekit = new BridgeKitJs(transport);
    bridgekit.connect();
    const stream = bridgekit.bridge(JsonStreamContract).values();
    let weak: WeakRef<object> | undefined;
    stream.subscribe((value) => {
      weak = new WeakRef(value as object);
    });
    const iterator = stream[Symbol.asyncIterator]();
    let payload: { large: number[] } | null = { large: new Array(100_000).fill(1) };
    transport.sessions[0]?.onNext(payload);
    payload = null;

    transport.sessions[0]?.onEnd({
      ok: false,
      code: 'PROVIDER_ERROR',
      message: 'failed',
    });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    for (let attempt = 0; attempt < 20; attempt++) {
      global.gc();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(weak?.deref()).toBeUndefined();
  });
});
