import { describe, expect, test } from '@jest/globals';
import { defineContract, t } from '../../contract/contract';
import type { BridgeScope, CallEnvelope, ResultEnvelope } from '../../contract/protocol';
import { BridgeKitJs } from '../bridgekit';
import { Dispatcher } from '../dispatcher';
import { Registry } from '../registry';
import { NativeReadinessMirror } from '../stateMirror';
import type { BridgeTransport, ConnectResult, JsDispatcher } from '../transport';

const NativeContract = defineContract('native.readiness.test', {
  methods: {
    ping: { kind: 'query', result: t.string() },
  },
  state: {
    status: { kind: 'state', value: t.string(), initial: 'initial' },
  },
});

const GLOBAL: BridgeScope = { kind: 'global' };
const FEATURE: BridgeScope = { kind: 'feature', feature: 'FeatureA' };
const INSTANCE: BridgeScope = {
  kind: 'instance',
  feature: 'FeatureA',
  instance: 'InstanceA',
};

function readinessDelta(
  op: 'provide' | 'unprovide',
  overrides?: Partial<CallEnvelope> & { seq?: number },
): CallEnvelope {
  return {
    op,
    contractId: NativeContract.descriptor.id,
    member: '',
    scope: GLOBAL,
    correlationId: '',
    epoch: 7,
    seq: 1,
    ...overrides,
  } as CallEnvelope;
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

class ReadinessTransport implements BridgeTransport {
  dispatcher: JsDispatcher | null = null;
  epoch = 7;
  connectResult: ConnectResult = { epoch: 7, snapshot: [], nativeProvided: [] };
  onConnect?: (dispatcher: JsDispatcher) => void;

  connect(dispatcher: JsDispatcher): ConnectResult {
    this.dispatcher = dispatcher;
    this.onConnect?.(dispatcher);
    return this.connectResult;
  }

  invoke(): Promise<ResultEnvelope> {
    return Promise.resolve({ ok: true, value: 'native' });
  }
  invokeSync(): ResultEnvelope {
    return { ok: true, value: 'native' };
  }
  openStream(): string {
    return 'stream-id';
  }
  closeStream(): void {}
  emitFromJs(): void {}
  endFromJs(): void {}
  stateRead(): ResultEnvelope {
    return { ok: true, value: 'ready' };
  }
  stateObserve(_env: CallEnvelope, onChange: (value: unknown) => void): string {
    onChange('ready');
    return 'obs-id';
  }
  stateUnobserve(): void {}
  stateWrite(): ResultEnvelope {
    return { ok: true };
  }
  pushProviderState(): void {}
  announceProvided(): void {}
  announceUnprovided(): void {}
}

describe('Native readiness mirror protocol', () => {
  test('Connect shape is accepted', () => {
    const mirror = new NativeReadinessMirror();

    mirror.hydrate([
      { contractId: NativeContract.descriptor.id, scope: FEATURE },
      { contractId: 'native.readiness.global', scope: GLOBAL },
    ]);

    expect(mirror.isProvided(NativeContract.descriptor.id, INSTANCE)).toBe(true);
    expect(mirror.isProvided('native.readiness.global', INSTANCE)).toBe(true);
    expect(mirror.isProvided('native.readiness.missing', INSTANCE)).toBe(false);
  });

  test('Delta shape is accepted', () => {
    const mirror = new NativeReadinessMirror();
    const dispatcher = new Dispatcher(new Registry(), new Map(), {
      nativeReadiness: mirror,
      getEpoch: () => 7,
    });

    dispatcher.onStateWrite(readinessDelta('provide', { scope: FEATURE, seq: 10 }));

    expect(mirror.isProvided(NativeContract.descriptor.id, INSTANCE)).toBe(true);
    expect(mirror.dump()).toEqual([
      {
        contractId: NativeContract.descriptor.id,
        provided: true,
        scopeKey: 'feature:FeatureA',
        seq: 10,
      },
    ]);
  });

  test('Stale delta rejected', () => {
    const mirror = new NativeReadinessMirror();
    const dispatcher = new Dispatcher(new Registry(), new Map(), {
      nativeReadiness: mirror,
      getEpoch: () => 7,
    });

    dispatcher.onStateWrite(readinessDelta('provide', { epoch: 6, seq: 1 }));

    expect(mirror.isProvided(NativeContract.descriptor.id, GLOBAL)).toBe(false);
    expect(mirror.dump()).toEqual([]);
  });

  test('latest-seq-wins application', () => {
    const mirror = new NativeReadinessMirror();
    const dispatcher = new Dispatcher(new Registry(), new Map(), {
      nativeReadiness: mirror,
      getEpoch: () => 7,
    });

    dispatcher.onStateWrite(readinessDelta('provide', { seq: 2 }));
    dispatcher.onStateWrite(readinessDelta('unprovide', { seq: 1 }));
    expect(mirror.isProvided(NativeContract.descriptor.id, GLOBAL)).toBe(true);

    dispatcher.onStateWrite(readinessDelta('unprovide', { seq: 3 }));
    expect(mirror.isProvided(NativeContract.descriptor.id, GLOBAL)).toBe(false);
    expect(mirror.dump()).toEqual([
      {
        contractId: NativeContract.descriptor.id,
        provided: false,
        scopeKey: 'global',
        seq: 3,
      },
    ]);
  });

  test('Delta queued during hydration', async () => {
    const transport = new ReadinessTransport();
    transport.connectResult = { epoch: 7, snapshot: [], nativeProvided: [] };
    transport.onConnect = (dispatcher) => {
      queueMicrotask(() => {
        dispatcher.onStateWrite(readinessDelta('provide', { epoch: 7, seq: 1 }));
      });
    };
    const bk = new BridgeKitJs(transport);

    bk.connect();
    expect(bk.nativeReadiness.isProvided(NativeContract.descriptor.id, GLOBAL)).toBe(false);

    await flushMicrotasks();
    expect(bk.nativeReadiness.isProvided(NativeContract.descriptor.id, GLOBAL)).toBe(true);
  });

  test('Full hydration order includes native readiness', () => {
    const transport = new ReadinessTransport();
    transport.connectResult = {
      epoch: 7,
      snapshot: [
        {
          contractId: NativeContract.descriptor.id,
          key: 'status',
          scope: GLOBAL,
          value: 'hydrated-state',
        },
      ],
      nativeProvided: [{ contractId: NativeContract.descriptor.id, scope: GLOBAL }],
    };
    const bk = new BridgeKitJs(transport);

    bk.connect();
    const state = bk.state(NativeContract, 'status', GLOBAL).get();

    expect(bk.dump().epoch).toBe(7);
    expect(state).toEqual({ value: 'hydrated-state', status: 'provided' });
    expect(bk.nativeReadiness.isProvided(NativeContract.descriptor.id, GLOBAL)).toBe(true);
  });
});
