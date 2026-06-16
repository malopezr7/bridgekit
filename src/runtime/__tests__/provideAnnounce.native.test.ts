// Stateless JS-provided contracts send an explicit provide announcement.
// transport.announceProvided() is called at provide()-time for ALL contracts
// so native always knows a contract is available even if it has no state keys.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { defineContract } from '../../contract/contract';
import { Async, Void } from '../../contract/markers';
import type { CallEnvelope, ResultEnvelope } from '../../contract/protocol';
import { t } from '../../contract/schema';
import { BridgeKitJs } from '../bridgekit';
import type { BridgeTransport, ConnectResult, JsDispatcher } from '../transport';

function makeMockNitroTransport(): BridgeTransport & {
  _writeEnvelopes: CallEnvelope[];
  _announceProvidedCalls: Array<{ contractId: string; scope: CallEnvelope['scope'] }>;
  _announceUnprovidedCalls: Array<{ contractId: string; scope: CallEnvelope['scope'] }>;
} {
  const writeEnvelopes: CallEnvelope[] = [];
  const announceProvidedCalls: Array<{ contractId: string; scope: CallEnvelope['scope'] }> = [];
  const announceUnprovidedCalls: Array<{ contractId: string; scope: CallEnvelope['scope'] }> = [];

  const t: BridgeTransport & {
    _writeEnvelopes: CallEnvelope[];
    _announceProvidedCalls: Array<{ contractId: string; scope: CallEnvelope['scope'] }>;
    _announceUnprovidedCalls: Array<{ contractId: string; scope: CallEnvelope['scope'] }>;
  } = {
    _writeEnvelopes: writeEnvelopes,
    _announceProvidedCalls: announceProvidedCalls,
    _announceUnprovidedCalls: announceUnprovidedCalls,

    connect(_dispatcher: JsDispatcher): ConnectResult {
      return { epoch: 1, snapshot: [] };
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

    stateObserve(_env: CallEnvelope, _onChange: (value: unknown) => void): string {
      return 'obs-1';
    },

    stateUnobserve(_obsId: string): void {},

    stateWrite(env: CallEnvelope): ResultEnvelope {
      writeEnvelopes.push({ ...env });
      return { ok: true };
    },

    pushProviderState(
      contractId: string,
      scope: import('../transport').BridgeScope,
      key: string,
      value: unknown,
    ): void {
      const env: CallEnvelope = {
        op: 'stateWrite',
        contractId,
        member: key,
        scope,
        payload: { v: value },
        correlationId: '',
        epoch: 1,
      };
      t.stateWrite(env);
    },

    announceProvided(contractId: string, scope: import('../transport').BridgeScope): void {
      announceProvidedCalls.push({ contractId, scope });
      // Simulate what NitroBridgeTransport will do: send {op:'provide'} through state.write.
      const env: CallEnvelope = {
        op: 'provide' as CallEnvelope['op'],
        contractId,
        member: '',
        scope,
        correlationId: '',
        epoch: 1,
      };
      t.stateWrite(env);
    },

    announceUnprovided(contractId: string, scope: import('../transport').BridgeScope): void {
      announceUnprovidedCalls.push({ contractId, scope });
      const env: CallEnvelope = {
        op: 'unprovide' as CallEnvelope['op'],
        contractId,
        member: '',
        scope,
        correlationId: '',
        epoch: 1,
      };
      t.stateWrite(env);
    },
  };

  return t;
}

const StatelessContract = defineContract('test.stateless', {
  methods: {
    greet: Async(t.object({ name: t.string() }), t.string()),
    notify: Void(),
  },
  streams: {},
  state: {},
});

describe("NitroBridgeTransport.announceProvided sends {op:'provide'} envelope", () => {
  it("announceProvided sends a stateWrite envelope with op='provide'", () => {
    const transport = makeMockNitroTransport();
    transport.announceProvided('test.stateless', { kind: 'global' });

    const provideEnvelopes = transport._writeEnvelopes.filter((e) => e.op === 'provide');
    expect(provideEnvelopes).toHaveLength(1);
    expect(provideEnvelopes[0]!.contractId).toBe('test.stateless');
    expect(provideEnvelopes[0]!.scope).toEqual({ kind: 'global' });
  });

  it("announceUnprovided sends a stateWrite envelope with op='unprovide'", () => {
    const transport = makeMockNitroTransport();
    transport.announceUnprovided('test.stateless', { kind: 'global' });

    const unprovideEnvelopes = transport._writeEnvelopes.filter((e) => e.op === 'unprovide');
    expect(unprovideEnvelopes).toHaveLength(1);
    expect(unprovideEnvelopes[0]!.contractId).toBe('test.stateless');
  });
});

describe('bridgekit.provide() calls announceProvided for stateless contract', () => {
  let transport: ReturnType<typeof makeMockNitroTransport>;
  let bk: BridgeKitJs;

  beforeEach(() => {
    transport = makeMockNitroTransport();
    bk = new BridgeKitJs(transport);
    bk.connect();
  });

  it('provide() calls transport.announceProvided exactly once for a stateless contract', () => {
    transport._announceProvidedCalls.length = 0;

    bk.provide(StatelessContract as import('../../contract/contract').BridgeContract<unknown>, {
      greet: async (p: unknown) => `Hello ${(p as { name: string }).name}`,
    });

    // announceProvided must have been called once for the stateless contract
    const calls = transport._announceProvidedCalls.filter((c) => c.contractId === 'test.stateless');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.scope).toEqual({ kind: 'global' });
  });

  it("provide() sends {op:'provide'} through state.write for stateless contract (real path)", () => {
    transport._writeEnvelopes.length = 0;

    bk.provide(StatelessContract as import('../../contract/contract').BridgeContract<unknown>, {});

    // There must be at least one {op:'provide'} envelope going to the native side.
    // A stateless contract has NO stateWrite calls — only the provide announcement.
    const provideEnvelopes = transport._writeEnvelopes.filter(
      (e) => e.op === 'provide' && e.contractId === 'test.stateless',
    );
    expect(provideEnvelopes.length).toBeGreaterThanOrEqual(1);
  });

  it('provide() with stateless contract: NO stateWrite envelopes (no state keys to push)', () => {
    transport._writeEnvelopes.length = 0;

    bk.provide(StatelessContract as import('../../contract/contract').BridgeContract<unknown>, {});

    const stateWriteEnvelopes = transport._writeEnvelopes.filter((e) => e.op === 'stateWrite');
    expect(stateWriteEnvelopes).toHaveLength(0);
  });

  it('binding.close() calls announceUnprovided for stateless contract', () => {
    const binding = bk.provide(
      StatelessContract as import('../../contract/contract').BridgeContract<unknown>,
      {},
    );

    transport._announceUnprovidedCalls.length = 0;
    binding.close('final');

    const calls = transport._announceUnprovidedCalls.filter(
      (c) => c.contractId === 'test.stateless',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('LoopbackTransport announce is a no-op (isProvided via registry)', () => {
  it('loopback announce does not throw and isProvided still works locally', () => {
    const { LoopbackTransport } =
      require('../loopbackTransport') as typeof import('../loopbackTransport');
    const loopback = new LoopbackTransport();
    const bkLoopback = new BridgeKitJs(loopback);
    bkLoopback.connect();

    // provide() must not throw even with loopback (announceProvided is a no-op there)
    expect(() => {
      bkLoopback.provide(
        StatelessContract as import('../../contract/contract').BridgeContract<unknown>,
        {
          greet: async (p: unknown) => `Hello ${(p as { name: string }).name}`,
        },
      );
    }).not.toThrow();

    // isProvided must be true locally (registry knows, no announce needed)
    const isProvided = bkLoopback.isProvided(
      StatelessContract as import('../../contract/contract').BridgeContract<unknown>,
    );
    expect(isProvided).toBe(true);
  });
});
