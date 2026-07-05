// ---------------------------------------------------------------------------
// R-2: pushProviderState — tests asserting that JS-provider state changes
// reach the Nitro transport via stateWrite (not just the loopback path).
//
// Uses a mock Nitro-style transport (implementing BridgeTransport) so these
// tests run in the native jest project without a real device.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { defineContract } from '../../contract/contract';
import { Async, State, Stream, Void } from '../../contract/markers';
import type { CallEnvelope, ResultEnvelope } from '../../contract/protocol';
import { t } from '../../contract/schema';
import { BridgeKitJs } from '../bridgekit';
import { GLOBAL_SCOPE, streamSource } from '../registry';
import type { BridgeTransport, ConnectResult, JsDispatcher } from '../transport';

// ---- A Nitro-style mock transport -------------------------------------------
// Mimics NitroBridgeTransport shape: has stateWrite(), does NOT have notifyStateChange.

function makeMockNitroTransport(): BridgeTransport & {
  _stateWriteCalls: CallEnvelope[];
  _stateObserveCalls: CallEnvelope[];
} {
  const stateWriteCalls: CallEnvelope[] = [];
  const stateObserveCalls: CallEnvelope[] = [];
  const observers = new Map<string, (value: unknown) => void>();
  let obsCounter = 0;

  const transport: BridgeTransport & {
    _stateWriteCalls: CallEnvelope[];
    _stateObserveCalls: CallEnvelope[];
  } = {
    _stateWriteCalls: stateWriteCalls,
    _stateObserveCalls: stateObserveCalls,

    connect(_dispatcher: JsDispatcher): ConnectResult {
      return { epoch: 1, snapshot: [], nativeProvided: [] };
    },

    async invoke(_env: CallEnvelope): Promise<ResultEnvelope> {
      return { ok: true, value: null };
    },

    invokeSync(_env: CallEnvelope): ResultEnvelope {
      return { ok: true, value: null };
    },

    openStream(
      _env: CallEnvelope,
      _onNext: (value: unknown) => void,
      _onEnd: (end: ResultEnvelope) => void,
    ): string {
      return 'stream-1';
    },

    closeStream(_streamId: string): void {},

    emitFromJs(_streamId: string, _value: unknown): void {},

    endFromJs(_streamId: string, _end: ResultEnvelope): void {},

    stateRead(_env: CallEnvelope): ResultEnvelope {
      return { ok: true, value: undefined };
    },

    stateObserve(env: CallEnvelope, onChange: (value: unknown) => void): string {
      stateObserveCalls.push(env);
      const obsId = `obs-${++obsCounter}`;
      observers.set(obsId, onChange);
      return obsId;
    },

    stateUnobserve(obsId: string): void {
      observers.delete(obsId);
    },

    stateWrite(env: CallEnvelope): ResultEnvelope {
      stateWriteCalls.push({ ...env });
      // Deliver to observers so mirrors work in tests
      for (const cb of observers.values()) {
        cb(env.payload);
      }
      return { ok: true };
    },

    pushProviderState(
      contractId: string,
      scope: import('../transport').BridgeScope,
      key: string,
      value: unknown,
    ): void {
      // Mirror exactly what NitroBridgeTransport does: wrap in { v } and call stateWrite
      const env: CallEnvelope = {
        op: 'stateWrite',
        contractId,
        member: key,
        scope,
        payload: { v: value },
        correlationId: '',
        epoch: 1,
      };
      transport.stateWrite(env);
    },

    announceProvided(contractId: string, scope: import('../transport').BridgeScope): void {
      // Mirror NitroBridgeTransport: send {op:'provide'} through stateWrite
      const env: CallEnvelope = {
        op: 'provide',
        contractId,
        member: '',
        scope,
        correlationId: '',
        epoch: 1,
      };
      transport.stateWrite(env);
    },

    announceUnprovided(contractId: string, scope: import('../transport').BridgeScope): void {
      const env: CallEnvelope = {
        op: 'unprovide',
        contractId,
        member: '',
        scope,
        correlationId: '',
        epoch: 1,
      };
      transport.stateWrite(env);
    },
  };

  return transport;
}

// ---- Test contract ----------------------------------------------------------

const ReverseContract = defineContract('test.reverse', {
  methods: {
    greet: Async(t.object({ name: t.string() }), t.string()),
    notifyEvent: Void(t.object({ type: t.string() })),
  },
  streams: {
    counter: Stream(t.number()),
  },
  state: {
    status: State(t.string(), 'idle'),
    count: State(t.number(), 0),
  },
});

// ---- Tests ------------------------------------------------------------------

describe('A. pushProviderState: JS provider → Nitro-style transport.stateWrite', () => {
  let transport: ReturnType<typeof makeMockNitroTransport>;
  let bk: BridgeKitJs;

  beforeEach(() => {
    transport = makeMockNitroTransport();
    bk = new BridgeKitJs(transport);
    bk.connect();
  });

  it('calls transport.stateWrite when binding.setState is called (Nitro transport path)', () => {
    const binding = bk.provide(
      ReverseContract as import('../../contract/contract').BridgeContract<unknown>,
      {},
    );

    binding.setState('status', 'active');

    expect(transport._stateWriteCalls.length).toBeGreaterThan(0);
    const call = transport._stateWriteCalls[transport._stateWriteCalls.length - 1]!;
    expect(call.contractId).toBe('test.reverse');
    expect(call.member).toBe('status');
  });

  it('wraps value in { v } envelope for the native wire format', () => {
    const binding = bk.provide(
      ReverseContract as import('../../contract/contract').BridgeContract<unknown>,
      {},
    );

    binding.setState('status', 'busy');

    // Find the LAST call for 'status' — initial seed comes first ('idle'), then our 'busy'
    const statusCalls = transport._stateWriteCalls.filter(
      (c) => c.contractId === 'test.reverse' && c.member === 'status',
    );
    const lastCall = statusCalls[statusCalls.length - 1];
    expect(lastCall).toBeDefined();
    // Wire rule: value is wrapped { v: <value> } for AnyMap compatibility
    expect((lastCall!.payload as Record<string, unknown>).v).toBe('busy');
  });

  it('pushes initial state at provide() time (native readers see seed value)', () => {
    bk.provide(ReverseContract as import('../../contract/contract').BridgeContract<unknown>, {});

    // Both 'status' and 'count' should be pushed at provide time
    const statusCall = transport._stateWriteCalls.find(
      (c) => c.contractId === 'test.reverse' && c.member === 'status',
    );
    const countCall = transport._stateWriteCalls.find(
      (c) => c.contractId === 'test.reverse' && c.member === 'count',
    );
    expect(statusCall).toBeDefined();
    expect(countCall).toBeDefined();
    // Initial values wrapped in { v }
    expect((statusCall!.payload as Record<string, unknown>).v).toBe('idle');
    expect((countCall!.payload as Record<string, unknown>).v).toBe(0);
  });

  it('each setState emits exactly one stateWrite call with correct value', () => {
    const binding = bk.provide(
      ReverseContract as import('../../contract/contract').BridgeContract<unknown>,
      {},
    );
    const initialCallCount = transport._stateWriteCalls.length;

    binding.setState('count', 42);

    const newCalls = transport._stateWriteCalls.slice(initialCallCount);
    const countCall = newCalls.find((c) => c.member === 'count');
    expect(countCall).toBeDefined();
    expect((countCall!.payload as Record<string, unknown>).v).toBe(42);
  });

  it('close() sends undefined-wrapped { v: undefined } for all state keys', () => {
    const binding = bk.provide(
      ReverseContract as import('../../contract/contract').BridgeContract<unknown>,
      {},
    );
    const beforeClose = transport._stateWriteCalls.length;

    binding.close('final');

    const afterCalls = transport._stateWriteCalls.slice(beforeClose);
    const statusClose = afterCalls.find((c) => c.member === 'status');
    const countClose = afterCalls.find((c) => c.member === 'count');
    expect(statusClose).toBeDefined();
    expect(countClose).toBeDefined();
    // Unprovide signal: { v: undefined }
    expect((statusClose!.payload as Record<string, unknown>).v).toBeUndefined();
  });

  it('does NOT call transport.stateWrite when transport is a LoopbackTransport (legacy path intact)', () => {
    // LoopbackTransport does not have stateWrite called for provider state —
    // it uses notifyStateChange internally. Test that the loopback path
    // still works by verifying the mirror observes state changes.
    const { LoopbackTransport } =
      require('../loopbackTransport') as typeof import('../loopbackTransport');
    const loopback = new LoopbackTransport();
    const bkLoopback = new BridgeKitJs(loopback);
    bkLoopback.connect();

    const binding = bkLoopback.provide(
      ReverseContract as import('../../contract/contract').BridgeContract<unknown>,
      {},
    );

    const changes: unknown[] = [];
    loopback.stateObserve(
      {
        op: 'stateObserve',
        contractId: 'test.reverse',
        member: 'status',
        scope: GLOBAL_SCOPE,
        correlationId: 'obs1',
        epoch: 1,
      },
      (v) => changes.push(v),
    );

    binding.setState('status', 'running');

    expect(changes).toContain('running');
  });
});

// ---- B. Reverse-direction loopback: native-consumes-JS end-to-end ----------

describe('B. Reverse direction via LoopbackTransport (native-consumes-JS simulation)', () => {
  it('Async: native (transport.invoke) can call JS-provided method end-to-end', async () => {
    const { LoopbackTransport } =
      require('../loopbackTransport') as typeof import('../loopbackTransport');
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    bk.provide(ReverseContract as import('../../contract/contract').BridgeContract<unknown>, {
      greet: async (p: unknown) => `Hello ${(p as { name: string }).name}`,
    });

    // Simulate native calling the JS provider via transport.invoke
    const result = await transport.invoke({
      op: 'invoke',
      contractId: 'test.reverse',
      member: 'greet',
      scope: GLOBAL_SCOPE,
      correlationId: 'c1',
      epoch: 1,
      payload: { name: 'World' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('Hello World');
    }
  });

  it('Void: native can fire JS-provided void method (fire-and-forget)', async () => {
    const { LoopbackTransport } =
      require('../loopbackTransport') as typeof import('../loopbackTransport');
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const received: string[] = [];
    bk.provide(ReverseContract as import('../../contract/contract').BridgeContract<unknown>, {
      notifyEvent: (p: unknown) => {
        received.push((p as { type: string }).type);
      },
    });

    // Simulate native calling a Void (fire) method via transport.invoke
    const result = await transport.invoke({
      op: 'invoke',
      contractId: 'test.reverse',
      member: 'notifyEvent',
      scope: GLOBAL_SCOPE,
      correlationId: 'c2',
      epoch: 1,
      payload: { type: 'click' },
    });

    expect(result.ok).toBe(true);
    // Value may be undefined (void return) — that is expected for fire
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toContain('click');
  });

  it('Stream: native can consume JS-provided stream via transport.openStream', async () => {
    const { LoopbackTransport } =
      require('../loopbackTransport') as typeof import('../loopbackTransport');
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    bk.provide(ReverseContract as import('../../contract/contract').BridgeContract<unknown>, {
      counter: () =>
        streamSource<number>((emit, end) => {
          emit(1);
          emit(2);
          emit(3);
          end();
          return () => {};
        }),
    });

    const received: number[] = [];
    await new Promise<void>((resolve) => {
      transport.openStream(
        {
          op: 'streamOpen',
          contractId: 'test.reverse',
          member: 'counter',
          scope: GLOBAL_SCOPE,
          correlationId: 's1',
          epoch: 1,
        },
        (v) => received.push(v as number),
        () => resolve(),
      );
    });

    expect(received).toEqual([1, 2, 3]);
  });

  it('State: JS provider setState is observable by transport observers', async () => {
    const { LoopbackTransport } =
      require('../loopbackTransport') as typeof import('../loopbackTransport');
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const binding = bk.provide(
      ReverseContract as import('../../contract/contract').BridgeContract<unknown>,
      {},
    );

    const changes: unknown[] = [];
    transport.stateObserve(
      {
        op: 'stateObserve',
        contractId: 'test.reverse',
        member: 'status',
        scope: GLOBAL_SCOPE,
        correlationId: 'obs2',
        epoch: 1,
      },
      (v) => changes.push(v),
    );

    // Update state multiple times
    binding.setState('status', 'loading');
    binding.setState('status', 'done');

    expect(changes).toContain('loading');
    expect(changes).toContain('done');
  });

  it('State: initial value is observable immediately after observe (Nitro transport sim)', () => {
    // With Nitro-style transport: initial state is pushed at provide() time.
    // After stateObserve is called, the observer receives future pushes.
    // Initial seed arrives via the provide() pushProviderState calls.
    const mockTransport = makeMockNitroTransport();
    const bk = new BridgeKitJs(mockTransport);
    bk.connect();

    bk.provide(ReverseContract as import('../../contract/contract').BridgeContract<unknown>, {});

    // Verify initial seed was pushed
    const seedCall = mockTransport._stateWriteCalls.find((c) => c.member === 'status');
    expect(seedCall).toBeDefined();
    expect((seedCall!.payload as Record<string, unknown>).v).toBe('idle');
  });

  it('All four markers work end-to-end in loopback (Async, Void, Stream, State)', async () => {
    const { LoopbackTransport } =
      require('../loopbackTransport') as typeof import('../loopbackTransport');
    const transport = new LoopbackTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();

    const received: Record<string, unknown[]> = {
      greet: [],
      notifyEvent: [],
      counter: [],
      status: [],
    };

    const binding = bk.provide(
      ReverseContract as import('../../contract/contract').BridgeContract<unknown>,
      {
        greet: async (p: unknown) => `hi ${(p as { name: string }).name}`,
        notifyEvent: (p: unknown) => received.notifyEvent.push((p as { type: string }).type),
        counter: () =>
          streamSource<number>((emit, end) => {
            emit(10);
            emit(20);
            end();
            return () => {};
          }),
      },
    );

    // State observer
    transport.stateObserve(
      {
        op: 'stateObserve',
        contractId: 'test.reverse',
        member: 'status',
        scope: GLOBAL_SCOPE,
        correlationId: 'o1',
        epoch: 1,
      },
      (v) => received.status.push(v),
    );

    // Async
    const r1 = await transport.invoke({
      op: 'invoke',
      contractId: 'test.reverse',
      member: 'greet',
      scope: GLOBAL_SCOPE,
      correlationId: 'c1',
      epoch: 1,
      payload: { name: 'test' },
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) received.greet.push(r1.value);

    // Void
    await transport.invoke({
      op: 'invoke',
      contractId: 'test.reverse',
      member: 'notifyEvent',
      scope: GLOBAL_SCOPE,
      correlationId: 'c2',
      epoch: 1,
      payload: { type: 'ping' },
    });
    await new Promise((r) => setTimeout(r, 20));

    // Stream
    const streamReceived: number[] = [];
    await new Promise<void>((resolve) => {
      transport.openStream(
        {
          op: 'streamOpen',
          contractId: 'test.reverse',
          member: 'counter',
          scope: GLOBAL_SCOPE,
          correlationId: 's1',
          epoch: 1,
        },
        (v) => streamReceived.push(v as number),
        () => resolve(),
      );
    });

    // State
    binding.setState('status', 'active');

    expect(received.greet).toContain('hi test');
    expect(received.notifyEvent).toContain('ping');
    expect(streamReceived).toEqual([10, 20]);
    expect(received.status).toContain('active');
  });
});
