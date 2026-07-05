import { describe, expect, jest, test } from '@jest/globals';
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

  test('Stale delta rejection does not notify readiness subscribers', () => {
    const mirror = new NativeReadinessMirror();
    const notifications: boolean[] = [];
    mirror.subscribe((record) => {
      notifications.push(record.provided);
    });
    const dispatcher = new Dispatcher(new Registry(), new Map(), {
      nativeReadiness: mirror,
      getEpoch: () => 7,
    });

    dispatcher.onStateWrite(readinessDelta('provide', { epoch: 6, seq: 1 }));

    expect(notifications).toEqual([]);
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

  test('Synchronous delta emitted during connect hydration is buffered and applied', () => {
    const transport = new ReadinessTransport();
    transport.connectResult = { epoch: 7, snapshot: [], nativeProvided: [] };
    transport.onConnect = (dispatcher) => {
      dispatcher.onStateWrite(readinessDelta('provide', { epoch: 7, seq: 1 }));
    };
    const bk = new BridgeKitJs(transport);

    bk.connect();
    expect(bk.nativeReadiness.isProvided(NativeContract.descriptor.id, GLOBAL)).toBe(true);
  });

  test('Reconnect hydration notifies subscribers when native provider disappears', () => {
    const transport = new ReadinessTransport();
    transport.connectResult = {
      epoch: 7,
      snapshot: [],
      nativeProvided: [{ contractId: NativeContract.descriptor.id, scope: GLOBAL }],
    };
    const bk = new BridgeKitJs(transport);
    const notifications: Array<{
      contractId: string;
      provided: boolean;
      scopeKey: string;
      seq: number;
    }> = [];
    bk.nativeReadiness.subscribe((record) => notifications.push(record));

    bk.connect();
    transport.connectResult = { epoch: 8, snapshot: [], nativeProvided: [] };
    bk.connect();

    expect(notifications).toContainEqual({
      contractId: NativeContract.descriptor.id,
      provided: false,
      scopeKey: 'global',
      seq: 0,
    });
  });

  test('Reconnect hydration clears native providers absent from the new epoch', () => {
    const transport = new ReadinessTransport();
    transport.connectResult = {
      epoch: 7,
      snapshot: [],
      nativeProvided: [{ contractId: NativeContract.descriptor.id, scope: GLOBAL }],
    };
    const bk = new BridgeKitJs(transport);

    bk.connect();
    transport.connectResult = { epoch: 8, snapshot: [], nativeProvided: [] };
    bk.connect();

    expect(bk.nativeReadiness.isProvided(NativeContract.descriptor.id, GLOBAL)).toBe(false);
  });

  test('Reconnect hydrates native readiness before replaying JS providers', () => {
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    const events: string[] = [];
    const transport = new ReadinessTransport();
    transport.announceProvided = () => {
      events.push('announceProvided');
    };
    transport.connectResult = { epoch: 7, snapshot: [], nativeProvided: [] };
    const bk = new BridgeKitJs(transport);
    bk.nativeReadiness.subscribe((record) => {
      if (record.provided) events.push('nativeReadinessHydrated');
    });

    try {
      bk.connect();
      bk.provide(NativeContract, { ping: () => Promise.resolve('js') }, { scope: GLOBAL });
      events.length = 0;
      transport.connectResult = {
        epoch: 8,
        snapshot: [],
        nativeProvided: [{ contractId: NativeContract.descriptor.id, scope: GLOBAL }],
      };
      bk.connect();

      expect(events).toEqual(['nativeReadinessHydrated', 'announceProvided']);
    } finally {
      debugSpy.mockRestore();
    }
  });

  test('Delta without numeric seq is ignored for old-native compatibility', () => {
    const mirror = new NativeReadinessMirror();
    const dispatcher = new Dispatcher(new Registry(), new Map(), {
      nativeReadiness: mirror,
      getEpoch: () => 7,
    });

    dispatcher.onStateWrite(readinessDelta('provide', { seq: undefined }));
    dispatcher.onStateWrite(readinessDelta('provide', { seq: Number.NaN }));

    expect(mirror.dump()).toEqual([]);
  });

  test('Failed reconnect aborts readiness hydration without keeping queued deltas', () => {
    const transport = new ReadinessTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();
    transport.onConnect = (dispatcher) => {
      dispatcher.onStateWrite(readinessDelta('provide', { epoch: 7, seq: 1 }));
      throw new Error('connect failed');
    };

    expect(() => bk.connect()).toThrow('connect failed');
    transport.dispatcher?.onStateWrite(readinessDelta('provide', { epoch: 7, seq: 2 }));

    expect(bk.nativeReadiness.dump()).toEqual([
      {
        contractId: NativeContract.descriptor.id,
        provided: true,
        scopeKey: 'global',
        seq: 2,
      },
    ]);
  });

  test('Subscriber exceptions during native readiness hydrate do not abort reconnect replay', () => {
    const transport = new ReadinessTransport();
    const announceCalls: string[] = [];
    transport.announceProvided = (contractId) => {
      announceCalls.push(contractId);
    };
    const bk = new BridgeKitJs(transport);
    bk.connect();
    bk.provide(NativeContract, { ping: () => Promise.resolve('js') }, { scope: GLOBAL });
    announceCalls.length = 0;
    const notified: boolean[] = [];
    bk.nativeReadiness.subscribe(() => {
      throw new Error('subscriber failed');
    });
    bk.nativeReadiness.subscribe((record) => {
      notified.push(record.provided);
    });
    transport.connectResult = {
      epoch: 8,
      snapshot: [],
      nativeProvided: [{ contractId: NativeContract.descriptor.id, scope: GLOBAL }],
    };

    expect(() => bk.connect()).not.toThrow();

    expect(notified).toEqual([true]);
    expect(announceCalls).toEqual([NativeContract.descriptor.id]);
  });

  test('Subscriber exceptions during state hydrate do not abort readiness hydration or replay', () => {
    const transport = new ReadinessTransport();
    const announceCalls: string[] = [];
    transport.announceProvided = (contractId) => {
      announceCalls.push(contractId);
    };
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const mirror = bk.state(NativeContract, 'status', GLOBAL);
    bk.provide(NativeContract, { ping: () => Promise.resolve('js') }, { scope: GLOBAL });
    let throwOnStateHydrate = false;
    mirror.subscribe(() => {
      if (throwOnStateHydrate) throw new Error('state subscriber failed');
    });
    const stateNotifications: unknown[] = [];
    mirror.subscribe((snapshot) => {
      stateNotifications.push(snapshot.value);
    });
    announceCalls.length = 0;
    stateNotifications.length = 0;
    throwOnStateHydrate = true;
    transport.connectResult = {
      epoch: 8,
      snapshot: [
        {
          contractId: NativeContract.descriptor.id,
          key: 'status',
          scope: GLOBAL,
          value: 'epoch-8-state',
        },
      ],
      nativeProvided: [{ contractId: NativeContract.descriptor.id, scope: GLOBAL }],
    };

    expect(() => bk.connect()).not.toThrow();

    expect(bk.dump().epoch).toBe(8);
    expect(bk.nativeReadiness.isProvided(NativeContract.descriptor.id, GLOBAL)).toBe(true);
    expect(announceCalls).toEqual([NativeContract.descriptor.id]);
    expect(stateNotifications).toContain('epoch-8-state');
  });

  test('Duplicate readiness delta with identical seq does not notify again', () => {
    const mirror = new NativeReadinessMirror();
    const notifications: boolean[] = [];
    mirror.subscribe((record) => {
      notifications.push(record.provided);
    });

    mirror.applyDelta({
      op: 'provide',
      contractId: NativeContract.descriptor.id,
      scope: GLOBAL,
      seq: 5,
    });
    mirror.applyDelta({
      op: 'provide',
      contractId: NativeContract.descriptor.id,
      scope: GLOBAL,
      seq: 5,
    });

    expect(notifications).toEqual([true]);
  });

  test('Reconnect absent does not duplicate already-unprovided native records', () => {
    const mirror = new NativeReadinessMirror();
    const notifications: boolean[] = [];
    mirror.subscribe((record) => {
      if (record.contractId === NativeContract.descriptor.id) notifications.push(record.provided);
    });

    mirror.applyDelta({
      op: 'provide',
      contractId: NativeContract.descriptor.id,
      scope: GLOBAL,
      seq: 1,
    });
    mirror.applyDelta({
      op: 'unprovide',
      contractId: NativeContract.descriptor.id,
      scope: GLOBAL,
      seq: 2,
    });
    mirror.hydrate([]);

    expect(notifications).toEqual([true, false]);
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
