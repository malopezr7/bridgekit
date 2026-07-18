import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { defineContract, t } from '../../contract/contract';
import type { ResultEnvelope } from '../../contract/protocol';
import { BridgeKitJs } from '../bridgekit';
import { diagnostics } from '../diagnostics';
import type { BridgeTransport, JsDispatcher } from '../transport';

const StreamContract = defineContract('ws11.stream-terminals', {
  streams: { values: t.stream(t.number()) },
});

class ControlledTransport implements BridgeTransport {
  onNext: ((value: unknown) => void) | null = null;
  onEnd: ((end: ResultEnvelope) => void) | null = null;

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
    return 'controlled-stream';
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
});
