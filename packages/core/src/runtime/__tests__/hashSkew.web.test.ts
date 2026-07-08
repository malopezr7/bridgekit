import { describe, expect, jest, test } from '@jest/globals';
import { defineContract, t } from '../../contract/contract';
import type { CallEnvelope, ResultEnvelope } from '../../contract/protocol';
import { Dispatcher } from '../dispatcher';
import { GLOBAL_SCOPE, Registry, streamSource } from '../registry';
import { NativeReadinessMirror } from '../stateMirror';
import type { BridgeTransport } from '../transport';

const HashSkewContract = defineContract('hash.skew', {
  methods: {
    echo: t.query(t.object({ value: t.string() }), t.string()),
  },
  streams: {
    events: t.stream(t.string()),
  },
  state: {
    status: t.state(t.string(), 'initial'),
  },
});

const receiverHash = HashSkewContract.hash;
const callerHash = '00000000';

function makeInvoke(contractHash?: string): CallEnvelope {
  return {
    op: 'invoke',
    contractId: HashSkewContract.descriptor.id,
    member: 'echo',
    scope: GLOBAL_SCOPE,
    payload: { value: 'hello' },
    correlationId: 'corr-invoke',
    epoch: 1,
    ...(contractHash !== undefined ? { contractHash } : {}),
  };
}

function makeStreamOpen(contractHash?: string): CallEnvelope {
  return {
    op: 'streamOpen',
    contractId: HashSkewContract.descriptor.id,
    member: 'events',
    scope: GLOBAL_SCOPE,
    correlationId: 'corr-stream',
    epoch: 1,
    ...(contractHash !== undefined ? { contractHash } : {}),
  };
}

function makeStateWrite(contractHash?: string): CallEnvelope {
  return {
    op: 'stateWrite',
    contractId: HashSkewContract.descriptor.id,
    member: 'status',
    scope: GLOBAL_SCOPE,
    payload: 'remote',
    correlationId: 'corr-state',
    epoch: 1,
    ...(contractHash !== undefined ? { contractHash } : {}),
  };
}

function makeHarness(strictHashCheck = false) {
  const registry = new Registry();
  const dispatcher = new Dispatcher(
    registry,
    new Map([[HashSkewContract.descriptor.id, HashSkewContract]]),
    { strictHashCheck } as never,
  );
  const ends = new Map<string, ResultEnvelope>();
  const values = new Map<string, unknown[]>();
  const transport = {
    emitFromJs(streamId: string, value: unknown): void {
      values.set(streamId, [...(values.get(streamId) ?? []), value]);
    },
    endFromJs(streamId: string, end: ResultEnvelope): void {
      ends.set(streamId, end);
    },
  } as BridgeTransport;
  dispatcher.setTransport(transport);
  const echo = jest.fn((params: { value: string }) => Promise.resolve(`echo:${params.value}`));
  const binding = registry.provide(HashSkewContract, {
    echo,
    events: () =>
      streamSource<string>((emit) => {
        emit('stream-value');
        return () => {};
      }),
  });
  return { binding, dispatcher, echo, ends, registry, values };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function expectIncompatible(result: ResultEnvelope): void {
  expect(result).toEqual(
    expect.objectContaining({
      ok: false,
      code: 'INCOMPATIBLE_CONTRACT',
      details: { callerHash, receiverHash },
    }),
  );
}

describe('hash skew enforcement', () => {
  test('hash_skew_web_observe_invoke_warns_and_dispatches_by_default', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { dispatcher, echo } = makeHarness();
    try {
      const result = await dispatcher.onInvoke(makeInvoke(callerHash));

      expect(result).toEqual({ ok: true, value: 'echo:hello' });
      expect(echo).toHaveBeenCalledWith({ value: 'hello' });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('INCOMPATIBLE_CONTRACT'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(callerHash));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(receiverHash));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('hash_skew_web_strict_invoke_rejects_without_dispatching', async () => {
    const { dispatcher, echo } = makeHarness(true);

    const result = await dispatcher.onInvoke(makeInvoke(callerHash));

    expectIncompatible(result);
    expect(echo).not.toHaveBeenCalled();
  });

  test('hash_skew_web_strict_stream_open_ends_without_starting_provider', async () => {
    const { dispatcher, ends, values } = makeHarness(true);

    dispatcher.onStreamOpen(makeStreamOpen(callerHash), 'stream-1');
    await flushMicrotasks();

    expectIncompatible(ends.get('stream-1') as ResultEnvelope);
    expect(values.get('stream-1')).toBeUndefined();
  });

  test('hash_skew_web_strict_state_write_rejects_writer', () => {
    const { dispatcher, registry } = makeHarness(true);

    const result = dispatcher.onStateWrite(makeStateWrite(callerHash)) as unknown as ResultEnvelope;

    expectIncompatible(result);
    expect(registry.getState(HashSkewContract.descriptor.id, GLOBAL_SCOPE, 'status')).toBe(
      'initial',
    );
  });

  test('hash_skew_missing_hash_and_readiness_ops_bypass', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const readiness = new NativeReadinessMirror();
    const dispatcher = new Dispatcher(
      new Registry(),
      new Map([[HashSkewContract.descriptor.id, HashSkewContract]]),
      { nativeReadiness: readiness, getEpoch: () => 1, strictHashCheck: true } as never,
    );
    try {
      const { dispatcher: strictDispatcher, echo, registry } = makeHarness(true);
      const invoke = await strictDispatcher.onInvoke(makeInvoke(undefined));
      const stateWrite = strictDispatcher.onStateWrite(
        makeStateWrite(undefined),
      ) as unknown as ResultEnvelope;

      const provideResult = dispatcher.onStateWrite({
        op: 'provide',
        contractId: HashSkewContract.descriptor.id,
        member: '',
        scope: GLOBAL_SCOPE,
        correlationId: 'corr-provide',
        epoch: 1,
        seq: 1,
      }) as unknown as ResultEnvelope;
      const providedAfterProvide = readiness.isProvided(
        HashSkewContract.descriptor.id,
        GLOBAL_SCOPE,
      );
      const unprovideResult = dispatcher.onStateWrite({
        op: 'unprovide',
        contractId: HashSkewContract.descriptor.id,
        member: '',
        scope: GLOBAL_SCOPE,
        correlationId: 'corr-unprovide',
        epoch: 1,
        seq: 2,
      }) as unknown as ResultEnvelope;

      expect(invoke).toEqual({ ok: true, value: 'echo:hello' });
      expect(echo).toHaveBeenCalledWith({ value: 'hello' });
      expect(stateWrite).toEqual({ ok: true });
      expect(registry.getState(HashSkewContract.descriptor.id, GLOBAL_SCOPE, 'status')).toBe(
        'remote',
      );
      expect(provideResult).toEqual({ ok: true });
      expect(providedAfterProvide).toBe(true);
      expect(readiness.isProvided(HashSkewContract.descriptor.id, GLOBAL_SCOPE)).toBe(false);
      expect(unprovideResult).toEqual({ ok: true });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
