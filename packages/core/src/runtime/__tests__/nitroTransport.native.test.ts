// ---------------------------------------------------------------------------
// NitroBridgeTransport — native jest tests.
// react-native-nitro-modules is mocked; tests cover wire-format mapping,
// error isolation, connect/epoch, stream open/close, and state observe.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// Mock react-native-nitro-modules using the module factory pattern.
// The factory returns a stable mock; per-test behaviour is set on the mock fns.
jest.mock('react-native-nitro-modules', () => {
  const mockFn = () => jest.fn();
  const hostMock = {
    invoke: mockFn(),
    invokeSync: mockFn(),
    connectDispatcher: mockFn(),
  };
  const streamsMock = {
    open: mockFn(),
    close: mockFn(),
    emitFromJs: mockFn(),
    endFromJs: mockFn(),
  };
  const stateMock = {
    read: mockFn(),
    observe: mockFn(),
    unobserve: mockFn(),
    write: mockFn(),
  };

  return {
    NitroModules: {
      createHybridObject: jest.fn((name: string) => {
        if (name === 'BridgeHost') return hostMock;
        if (name === 'BridgeStreams') return streamsMock;
        if (name === 'BridgeState') return stateMock;
        throw new Error(`Unknown hybrid: ${name}`);
      }),
      _hostMock: hostMock,
      _streamsMock: streamsMock,
      _stateMock: stateMock,
    },
  };
});

// Import AFTER mock
import type { CallEnvelope, ResultEnvelope } from '../../contract/protocol';
import { diagnostics } from '../diagnostics';
import { NitroBridgeTransport } from '../nitroTransport';
import type { JsDispatcher } from '../transport';

// Grab mock objects from the module
type NitroMockModule = {
  NitroModules: {
    createHybridObject: jest.Mock;
    _hostMock: Record<string, jest.Mock>;
    _streamsMock: Record<string, jest.Mock>;
    _stateMock: Record<string, jest.Mock>;
  };
};

function getMocks() {
  const mod = jest.requireMock('react-native-nitro-modules') as NitroMockModule;
  return {
    host: mod.NitroModules._hostMock,
    streams: mod.NitroModules._streamsMock,
    state: mod.NitroModules._stateMock,
  };
}

// ---- helpers ----------------------------------------------------------------

const baseEnv: CallEnvelope = {
  op: 'invoke',
  contractId: 'test.contract',
  member: 'doThing',
  scope: { kind: 'global' },
  correlationId: 'cid-1',
  epoch: 0,
};

function makeDispatcher(overrides?: Partial<JsDispatcher>): jest.Mocked<JsDispatcher> {
  return {
    onInvoke: jest.fn<JsDispatcher['onInvoke']>().mockResolvedValue({ ok: true, value: 42 }),
    onStreamOpen: jest.fn(),
    onStreamClose: jest.fn(),
    onStateWrite: jest.fn(),
    ...overrides,
  } as jest.Mocked<JsDispatcher>;
}

// ---- setup ------------------------------------------------------------------

beforeEach(() => {
  const { host, streams, state } = getMocks();
  // Reset all mock fns to clean state before each test
  for (const fn of Object.values(host)) fn.mockReset();
  for (const fn of Object.values(streams)) fn.mockReset();
  for (const fn of Object.values(state)) fn.mockReset();
});

// ---- connect / epoch --------------------------------------------------------

describe('connect', () => {
  it('calls connectDispatcher and parses epoch + empty snapshot', () => {
    const { host } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 3, snapshot: [] });

    const transport = new NitroBridgeTransport();
    const result = transport.connect(makeDispatcher());

    expect(host.connectDispatcher).toHaveBeenCalledTimes(1);
    expect(result.epoch).toBe(3);
    expect(result.snapshot).toEqual([]);
  });

  it('Absent/malformed epoch falls back to 0', () => {
    const { host } = getMocks();
    const transport = new NitroBridgeTransport();

    host.connectDispatcher.mockReturnValueOnce({ snapshot: [] });
    expect(transport.connect(makeDispatcher()).epoch).toBe(0);

    host.connectDispatcher.mockReturnValueOnce({ epoch: 'not-a-number', snapshot: [] });
    expect(transport.connect(makeDispatcher()).epoch).toBe(0);
  });

  it('Native single-wrap fixture hydrates value', () => {
    const { host } = getMocks();
    host.connectDispatcher.mockReturnValue({
      epoch: 1,
      snapshot: [
        {
          contractId: 'a.b',
          key: 'status',
          scope: { kind: 'global' },
          v: 'ready',
        },
      ],
    });

    const transport = new NitroBridgeTransport();
    const { snapshot } = transport.connect(makeDispatcher());

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.value).toBe('ready');
    expect(snapshot[0]?.contractId).toBe('a.b');
  });

  it('connectDispatcher returns nativeProvided', () => {
    const { host } = getMocks();
    host.connectDispatcher.mockReturnValue({
      epoch: 11,
      snapshot: [],
      nativeProvided: [
        {
          contractId: 'native.contract',
          scope: { kind: 'feature', feature: 'FeatureA' },
        },
      ],
    });

    const transport = new NitroBridgeTransport();
    const result = transport.connect(makeDispatcher());

    expect(result.nativeProvided).toEqual([
      {
        contractId: 'native.contract',
        scope: { kind: 'feature', feature: 'FeatureA' },
      },
    ]);
  });

  it('Object values are not double-unwrapped', () => {
    const { host } = getMocks();
    host.connectDispatcher.mockReturnValue({
      epoch: 1,
      snapshot: [
        {
          contractId: 'a.b',
          key: 'details',
          scope: { kind: 'global' },
          v: { nested: true },
        },
      ],
    });

    const transport = new NitroBridgeTransport();
    const { snapshot } = transport.connect(makeDispatcher());

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.value).toEqual({ nested: true });
    expect(snapshot[0]?.key).toBe('details');
  });

  it('stamps epoch onto outgoing invoke envelopes', async () => {
    const { host } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 7, snapshot: [] });
    host.invoke.mockResolvedValue({ ok: true, value: null });

    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    await transport.invoke(baseEnv);

    const arg = host.invoke.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.epoch).toBe(7);
  });
});

// ---- invoke envelope round trip ---------------------------------------------

describe('invoke', () => {
  it('maps CallEnvelope to AnyMap and result back to ResultEnvelope (ok:true)', async () => {
    const { host } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 1, snapshot: [] });
    host.invoke.mockResolvedValue({ ok: true, value: 'hello' });

    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    const result = await transport.invoke({ ...baseEnv, payload: { x: 1 } });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('hello');

    const sentMap = host.invoke.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sentMap.op).toBe('invoke');
    expect(sentMap.contractId).toBe('test.contract');
    expect(sentMap.member).toBe('doThing');
    expect((sentMap.payload as Record<string, unknown>).x).toBe(1);
  });

  it('maps ok:false result to ResultErr envelope', async () => {
    const { host } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 1, snapshot: [] });
    host.invoke.mockResolvedValue({
      ok: false,
      code: 'CONTRACT_NOT_PROVIDED',
      message: 'nope',
      contractId: 'test.contract',
      member: 'doThing',
    });

    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    const result = await transport.invoke(baseEnv);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('CONTRACT_NOT_PROVIDED');
      expect(result.message).toBe('nope');
    }
  });

  it('returns PROVIDER_ERROR envelope when Nitro throws', async () => {
    const { host } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 1, snapshot: [] });
    host.invoke.mockRejectedValue(new Error('native crash'));

    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    const result = await transport.invoke(baseEnv);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROVIDER_ERROR');
  });
});

// ---- onInvoke never rejects -------------------------------------------------

describe('onInvoke callback', () => {
  it('never rejects when the dispatcher throws — resolves ok:false instead', async () => {
    const { host } = getMocks();
    let capturedOnInvoke: ((env: unknown) => Promise<unknown>) | undefined;

    host.connectDispatcher.mockImplementation(
      (_epochInfo: unknown, onInvoke: (env: unknown) => Promise<unknown>) => {
        capturedOnInvoke = onInvoke;
        return { epoch: 1, snapshot: [] };
      },
    );

    const dispatcher = makeDispatcher({
      onInvoke: jest.fn<JsDispatcher['onInvoke']>().mockRejectedValue(new Error('dispatcher boom')),
    });

    const transport = new NitroBridgeTransport();
    transport.connect(dispatcher);

    const envMap = {
      op: 'invoke',
      contractId: 'x.y',
      member: 'method',
      scope: { kind: 'global' },
      correlationId: 'cid',
      epoch: 1,
    };

    // Must resolve, never reject
    await expect(capturedOnInvoke?.(envMap)).resolves.toBeDefined();
  });

  it('never rejects when the dispatcher resolves ok:false', async () => {
    const { host } = getMocks();
    let capturedOnInvoke: ((env: unknown) => Promise<unknown>) | undefined;

    host.connectDispatcher.mockImplementation(
      (_epochInfo: unknown, onInvoke: (env: unknown) => Promise<unknown>) => {
        capturedOnInvoke = onInvoke;
        return { epoch: 1, snapshot: [] };
      },
    );

    const errResult: ResultEnvelope = {
      ok: false,
      code: 'PROVIDER_ERROR',
      message: 'error in provider',
    };
    const dispatcher = makeDispatcher({
      onInvoke: jest.fn<JsDispatcher['onInvoke']>().mockResolvedValue(errResult),
    });

    const transport = new NitroBridgeTransport();
    transport.connect(dispatcher);

    const envMap = {
      op: 'invoke',
      contractId: 'x.y',
      member: 'method',
      scope: { kind: 'global' },
      correlationId: 'cid',
      epoch: 1,
    };

    await expect(capturedOnInvoke?.(envMap)).resolves.toBeDefined();
  });
});

// ---- stream open / close / { v } wrapping -----------------------------------

describe('openStream', () => {
  it('carries latestOnly and sticky flags across the Nitro wire in both directions', () => {
    const { host, streams } = getMocks();
    let capturedOnStreamOpen: ((env: unknown) => void) | undefined;
    host.connectDispatcher.mockImplementation(
      (_epochInfo: unknown, _onInvoke: unknown, onStreamOpen: (env: unknown) => void) => {
        capturedOnStreamOpen = onStreamOpen;
        return { epoch: 1, snapshot: [] };
      },
    );
    streams.open.mockReturnValue('stream-flags');
    const dispatcher = makeDispatcher();

    const transport = new NitroBridgeTransport();
    transport.connect(dispatcher);

    transport.openStream(
      { ...baseEnv, op: 'streamOpen', latestOnly: true, sticky: true },
      jest.fn(),
      jest.fn(),
    );

    expect(streams.open.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ latestOnly: true, sticky: true }),
    );

    capturedOnStreamOpen?.({
      ...baseEnv,
      op: 'streamOpen',
      streamId: 'native-stream',
      latestOnly: true,
      sticky: true,
    });

    expect(dispatcher.onStreamOpen).toHaveBeenCalledWith(
      expect.objectContaining({ latestOnly: true, sticky: true }),
      'native-stream',
    );
  });

  it('passes envelope and captures onNext/onEnd callbacks', () => {
    const { host, streams } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 1, snapshot: [] });
    streams.open.mockReturnValue('stream-1');

    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    const onNext = jest.fn();
    const onEnd = jest.fn();

    const streamId = transport.openStream({ ...baseEnv, op: 'streamOpen' }, onNext, onEnd);

    expect(streamId).toBe('stream-1');
    expect(streams.open).toHaveBeenCalledTimes(1);

    // Simulate native calling onNext with { v: 'tick' }
    const passedOnNext = streams.open.mock.calls[0]?.[1] as (v: Record<string, unknown>) => void;
    passedOnNext({ v: 'tick' });
    expect(onNext).toHaveBeenCalledWith('tick');

    // Simulate native calling onEnd with ok:true envelope
    const passedOnEnd = streams.open.mock.calls[0]?.[2] as (e: Record<string, unknown>) => void;
    passedOnEnd({ ok: true });
    expect(onEnd).toHaveBeenCalledWith({ ok: true, value: undefined });
  });

  it('unwraps { v } from onNext — primitive and null', () => {
    const { host, streams } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 1, snapshot: [] });
    streams.open.mockReturnValue('stream-2');

    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    const onNext = jest.fn();
    transport.openStream({ ...baseEnv, op: 'streamOpen' }, onNext, jest.fn());

    const passedOnNext = streams.open.mock.calls[0]?.[1] as (v: Record<string, unknown>) => void;

    passedOnNext({ v: null });
    expect(onNext).toHaveBeenLastCalledWith(null);

    passedOnNext({ v: 99 });
    expect(onNext).toHaveBeenLastCalledWith(99);

    passedOnNext({ v: [1, 2] });
    expect(onNext).toHaveBeenLastCalledWith([1, 2]);
  });
});

describe('emitFromJs', () => {
  it('wraps value in { v } before crossing to native', () => {
    const { host, streams } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 1, snapshot: [] });

    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    transport.emitFromJs('stream-1', 'hello');
    expect(streams.emitFromJs).toHaveBeenCalledWith('stream-1', { v: 'hello' });

    transport.emitFromJs('stream-1', { nested: true });
    expect(streams.emitFromJs).toHaveBeenLastCalledWith('stream-1', { v: { nested: true } });
  });
});

describe('closeStream', () => {
  it('delegates to native close', () => {
    const { host, streams } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 1, snapshot: [] });

    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    transport.closeStream('stream-abc');
    expect(streams.close).toHaveBeenCalledWith('stream-abc');
  });
});

// ---- state observe / unobserve ----------------------------------------------

describe('stateObserve', () => {
  it('passes envelope and unwraps { v } from onChange', () => {
    const { host, state } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 1, snapshot: [] });
    state.observe.mockReturnValue('obs-1');

    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    const onChange = jest.fn();
    const stateEnv: CallEnvelope = {
      ...baseEnv,
      op: 'stateObserve',
      member: 'status',
    };

    const obsId = transport.stateObserve(stateEnv, onChange);
    expect(obsId).toBe('obs-1');

    // Simulate native calling onChange with { v: 'active' }
    const passedOnChange = state.observe.mock.calls[0]?.[1] as (v: Record<string, unknown>) => void;
    passedOnChange({ v: 'active' });
    expect(onChange).toHaveBeenCalledWith('active');
  });
});

describe('stateUnobserve', () => {
  it('delegates to native unobserve', () => {
    const { host, state } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 1, snapshot: [] });

    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    transport.stateUnobserve('obs-xyz');
    expect(state.unobserve).toHaveBeenCalledWith('obs-xyz');
  });
});

describe('guarded state announcements', () => {
  it('routes provided and unprovided writes through the stateWrite guard', () => {
    const { host, state } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 1, snapshot: [] });
    state.write.mockImplementation(() => {
      throw new Error('native announcement failure');
    });
    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    expect(() => transport.announceProvided('test.contract', { kind: 'global' })).not.toThrow();
    expect(() => transport.announceUnprovided('test.contract', { kind: 'global' })).not.toThrow();
    expect(state.write.mock.calls.map(([write]) => write.op)).toEqual(['provide', 'unprovide']);
  });

  it('surfaces failed announcements through diagnostics instead of discarding them', () => {
    // JD2-004: an ok:false announcement envelope must increment error
    // diagnostics and emit a dev warning — silent readiness divergence is not ok.
    const { host, state } = getMocks();
    host.connectDispatcher.mockReturnValue({ epoch: 1, snapshot: [] });
    state.write.mockImplementation(() => {
      throw new Error('native announcement failure');
    });
    const transport = new NitroBridgeTransport();
    transport.connect(makeDispatcher());

    diagnostics.reset();
    transport.announceProvided('test.contract', { kind: 'global' });
    expect(diagnostics.getCounters().errors).toBe(1);
    transport.announceUnprovided('test.contract', { kind: 'global' });
    expect(diagnostics.getCounters().errors).toBe(2);
  });
});
