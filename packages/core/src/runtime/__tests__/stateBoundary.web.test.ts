import { beforeEach, describe, expect, it } from '@jest/globals';
import { type BridgeContract, defineContract, t } from '../../contract/contract';
import { type CallEnvelope, isBridgeError, type ResultEnvelope } from '../../contract/protocol';
import { BridgeKitJs } from '../bridgekit';
import { diagnostics } from '../diagnostics';
import { GLOBAL_SCOPE } from '../registry';
import type { BridgeScope, BridgeTransport, ConnectResult, JsDispatcher } from '../transport';

interface StatePush {
  contractId: string;
  scope: BridgeScope;
  key: string;
  value: unknown;
}

class StateBoundaryTransport implements BridgeTransport {
  pushes: StatePush[] = [];
  announces: Array<{ op: 'provide' | 'unprovide'; contractId: string }> = [];
  snapshot: ConnectResult['snapshot'] = [];
  private readonly observers = new Map<string, (value: unknown) => void>();

  connect(_dispatcher: JsDispatcher): ConnectResult {
    return { epoch: 1, snapshot: this.snapshot, nativeProvided: [] };
  }
  invoke(): Promise<ResultEnvelope> {
    return Promise.resolve({ ok: true });
  }
  invokeSync(): ResultEnvelope {
    return { ok: true };
  }
  openStream(): string {
    return 'stream-id';
  }
  closeStream(): void {}
  emitFromJs(): void {}
  endFromJs(): void {}
  stateRead(): ResultEnvelope {
    return { ok: true };
  }
  stateObserve(env: CallEnvelope, onChange: (value: unknown) => void): string {
    this.observers.set(env.member, onChange);
    return `obs-${env.member}`;
  }
  stateUnobserve(obsId: string): void {
    this.observers.delete(obsId.replace(/^obs-/, ''));
  }
  stateWrite(): ResultEnvelope {
    return { ok: true };
  }
  pushProviderState(contractId: string, scope: BridgeScope, key: string, value: unknown): void {
    this.pushes.push({ contractId, scope, key, value });
  }
  announceProvided(contractId: string): void {
    this.announces.push({ op: 'provide', contractId });
  }
  announceUnprovided(contractId: string): void {
    this.announces.push({ op: 'unprovide', contractId });
  }
  emitNative(key: string, value: unknown): void {
    const observer = this.observers.get(key);
    if (!observer) throw new Error(`Missing observer for ${key}`);
    observer(value);
  }
}

const Int64State = defineContract('ws11.state.int64', { state: { value: t.state(t.int64(), 0n) } });
const DateState = defineContract('ws11.state.date', {
  state: { value: t.state(t.date(), new Date(0)) },
});
const BinaryState = defineContract('ws11.state.binary', {
  state: { value: t.state(t.binary(), new Uint8Array()) },
});
const OptionalState = defineContract('ws11.state.optional', {
  state: { value: t.state(t.optional(t.string()), 'seed') },
});
const JsonState = defineContract('ws11.state.json', {
  state: { value: t.state(t.json(), { seed: true }) },
});
const NumberState = defineContract('ws11.state.number', {
  state: { value: t.state(t.number(), 0) },
});

interface StateCase {
  name: string;
  contract: BridgeContract<unknown>;
  jsValue: unknown;
  wireValue: unknown;
  assertJsValue(value: unknown): void;
}

const STATE_CASES: StateCase[] = [
  {
    name: 'int64',
    contract: Int64State as BridgeContract<unknown>,
    jsValue: 9007199254740993n,
    wireValue: '9007199254740993',
    assertJsValue: (value) => expect(value).toBe(9007199254740993n),
  },
  {
    name: 'date',
    contract: DateState as BridgeContract<unknown>,
    jsValue: new Date('2025-06-14T12:00:00.000Z'),
    wireValue: 1749902400000,
    assertJsValue: (value) => expect((value as Date).getTime()).toBe(1749902400000),
  },
  {
    name: 'binary',
    contract: BinaryState as BridgeContract<unknown>,
    jsValue: new Uint8Array([1, 2, 255]),
    wireValue: 'AQL/',
    assertJsValue: (value) => expect(Array.from(value as Uint8Array)).toEqual([1, 2, 255]),
  },
];

function setup() {
  const transport = new StateBoundaryTransport();
  const bridgeKit = new BridgeKitJs(transport);
  bridgeKit.connect();
  return { bridgeKit, transport };
}

function observe(contract: BridgeContract<unknown>) {
  const { bridgeKit, transport } = setup();
  const mirror = bridgeKit.state(contract, 'value');
  const snapshots: unknown[] = [];
  const unsubscribe = mirror.subscribe((snapshot) => snapshots.push(snapshot));
  return { bridgeKit, mirror, snapshots, transport, unsubscribe };
}

beforeEach(() => diagnostics.reset());

describe('WS11 state schema boundary', () => {
  it.each(STATE_CASES)('encodes $name before the JS-to-native push', (stateCase) => {
    const { bridgeKit, transport } = setup();
    const binding = bridgeKit.provide(stateCase.contract, {});
    transport.pushes = [];
    binding.setState('value', stateCase.jsValue);
    expect(transport.pushes[0]).toEqual({
      contractId: stateCase.contract.descriptor.id,
      scope: GLOBAL_SCOPE,
      key: 'value',
      value: stateCase.wireValue,
    });
    expect(transport.pushes).toHaveLength(1);
  });

  it.each(STATE_CASES)('decodes $name from a native observation', (stateCase) => {
    const { mirror, transport, unsubscribe } = observe(stateCase.contract);
    transport.emitNative('value', stateCase.wireValue);
    stateCase.assertJsValue(mirror.get().value);
    expect(mirror.get().status).toBe('provided');
    expect(mirror.get().error).toBeUndefined();
    unsubscribe();
  });

  it.each(STATE_CASES)('preserves the original $name value on local loopback', (stateCase) => {
    const { bridgeKit } = setup();
    const binding = bridgeKit.provide(stateCase.contract, {});
    const mirror = bridgeKit.state(stateCase.contract, 'value');
    const unsubscribe = mirror.subscribe(() => {});
    binding.setState('value', stateCase.jsValue);
    stateCase.assertJsValue(mirror.get().value);
    unsubscribe();
  });

  it('decodes hydrated native state before publishing the snapshot', () => {
    const transport = new StateBoundaryTransport();
    transport.snapshot = [
      {
        contractId: Int64State.descriptor.id,
        key: 'value',
        scope: GLOBAL_SCOPE,
        value: '9007199254740993',
      },
    ];
    const bridgeKit = new BridgeKitJs(transport);
    const mirror = bridgeKit.state(Int64State as BridgeContract<unknown>, 'value');
    bridgeKit.connect();
    expect(mirror.get()).toEqual({ value: 9007199254740993n, status: 'provided' });
  });

  it('retains last-good state on decode and validation failures, then clears the error', () => {
    const int64 = observe(Int64State as BridgeContract<unknown>);
    int64.transport.emitNative('value', '41');
    int64.transport.emitNative('value', 42);
    expect(int64.mirror.get().value).toBe(41n);
    expect(int64.mirror.get().error?.code).toBe('INCOMPATIBLE_CONTRACT');
    expect(int64.snapshots).toHaveLength(2);
    int64.transport.emitNative('value', '43');
    expect(int64.mirror.get()).toEqual({ value: 43n, status: 'provided' });

    const number = observe(NumberState as BridgeContract<unknown>);
    number.transport.emitNative('value', 7);
    number.transport.emitNative('value', 'not-a-number');
    expect(number.mirror.get().value).toBe(7);
    expect(number.mirror.get().error?.code).toBe('INCOMPATIBLE_CONTRACT');
    expect(diagnostics.getCounters().errors).toBe(2);
    int64.unsubscribe();
    number.unsubscribe();
  });

  it('rejects top-level undefined with VALIDATION_FAILED before transport', () => {
    const { bridgeKit, transport } = setup();
    const binding = bridgeKit.provide(OptionalState as BridgeContract<unknown>, {});
    transport.pushes = [];

    let thrown: unknown;
    try {
      binding.setState('value', undefined);
    } catch (error) {
      thrown = error;
    }
    expect(isBridgeError(thrown, 'VALIDATION_FAILED')).toBe(true);
    expect(transport.pushes).toEqual([]);
  });

  it('provides atomically when an optional multi-key initial is undefined', () => {
    // JD2-001: an undefined optional initial must not throw mid-push, leave a
    // zombie binding, or skip the provide announcement on multi-key contracts.
    const MixedState = defineContract('ws11.state.mixed', {
      state: {
        label: t.state(t.string(), 'seed'),
        note: t.state(t.optional(t.string()), undefined),
      },
    });
    const { bridgeKit, transport } = setup();
    const binding = bridgeKit.provide(MixedState as BridgeContract<unknown>, {});
    expect(bridgeKit.isProvided(MixedState as BridgeContract<unknown>)).toBe(true);
    expect(transport.announces).toEqual([{ op: 'provide', contractId: 'ws11.state.mixed' }]);
    // Defined initial pushed; undefined initial is skipped on the wire because
    // top-level undefined stays reserved for provider removal.
    expect(transport.pushes).toEqual([
      { contractId: 'ws11.state.mixed', scope: GLOBAL_SCOPE, key: 'label', value: 'seed' },
    ]);
    binding.setState('note', 'hello');
    expect(transport.pushes).toHaveLength(2);
    expect(transport.pushes[1]?.value).toBe('hello');
  });

  it('falls back to the typed initial when schema attaches after raw hydration decode fails', () => {
    // JD2-002: a schema-less hydrated mirror must not leak the raw wire value
    // as last-good once the schema attaches and decode fails.
    const transport = new StateBoundaryTransport();
    transport.snapshot = [
      {
        contractId: Int64State.descriptor.id,
        key: 'value',
        scope: GLOBAL_SCOPE,
        value: 42,
      },
    ];
    const bridgeKit = new BridgeKitJs(transport);
    bridgeKit.connect();
    const mirror = bridgeKit.state(Int64State as BridgeContract<unknown>, 'value');
    const snapshot = mirror.get();
    expect(snapshot.value).toBe(0n);
    expect(snapshot.error?.code).toBe('INCOMPATIBLE_CONTRACT');
    expect(diagnostics.getCounters().errors).toBe(1);
  });

  it('falls back to the typed initial when a stale schema-less value fails to decode', () => {
    const transport = new StateBoundaryTransport();
    transport.snapshot = [
      {
        contractId: Int64State.descriptor.id,
        key: 'value',
        scope: GLOBAL_SCOPE,
        value: 42,
      },
    ];
    const bridgeKit = new BridgeKitJs(transport);
    bridgeKit.connect();
    transport.snapshot = [];
    bridgeKit.connect();

    const mirror = bridgeKit.state(Int64State as BridgeContract<unknown>, 'value');

    expect(mirror.get().value).toBe(0n);
    expect(mirror.get().status).toBe('stale');
    expect(mirror.get().error?.code).toBe('INCOMPATIBLE_CONTRACT');
    expect(diagnostics.getCounters().errors).toBe(1);
  });

  it('decodes a stale schema-less value when its schema attaches', () => {
    const transport = new StateBoundaryTransport();
    transport.snapshot = [
      {
        contractId: Int64State.descriptor.id,
        key: 'value',
        scope: GLOBAL_SCOPE,
        value: '42',
      },
    ];
    const bridgeKit = new BridgeKitJs(transport);
    bridgeKit.connect();
    transport.snapshot = [];
    bridgeKit.connect();

    const mirror = bridgeKit.state(Int64State as BridgeContract<unknown>, 'value');

    expect(mirror.get()).toEqual({ value: 42n, status: 'stale' });
    expect(diagnostics.getCounters().errors).toBe(0);
  });

  it('latches an error and keeps last-good when binary wire is wrong-typed', () => {
    // JD2-003: wrong-typed binary wire must not silently decode to empty bytes.
    const binary = observe(BinaryState as BridgeContract<unknown>);
    binary.transport.emitNative('value', 'AQL/');
    binary.transport.emitNative('value', 42);
    expect(Array.from(binary.mirror.get().value as Uint8Array)).toEqual([1, 2, 255]);
    expect(binary.mirror.get().error?.code).toBe('INCOMPATIBLE_CONTRACT');
    binary.unsubscribe();
  });

  it('rejects an empty-string int64 wire value instead of decoding it to 0n', () => {
    // JD2-003 (related): BigInt('') silently yields 0n.
    const int64 = observe(Int64State as BridgeContract<unknown>);
    int64.transport.emitNative('value', '41');
    int64.transport.emitNative('value', '');
    expect(int64.mirror.get().value).toBe(41n);
    expect(int64.mirror.get().error?.code).toBe('INCOMPATIBLE_CONTRACT');
    int64.unsubscribe();
  });

  it('sanitizes nested JSON undefined but retains the original local object', () => {
    const { bridgeKit, transport } = setup();
    const binding = bridgeKit.provide(JsonState as BridgeContract<unknown>, {});
    const mirror = bridgeKit.state(JsonState as BridgeContract<unknown>, 'value');
    const unsubscribe = mirror.subscribe(() => {});
    const value = { keep: 'yes', drop: undefined };
    transport.pushes = [];
    binding.setState('value', value);
    expect(Object.hasOwn(transport.pushes[0]?.value as object, 'drop')).toBe(false);
    expect(mirror.get().value).toBe(value);
    expect(Object.hasOwn(mirror.get().value as object, 'drop')).toBe(true);
    unsubscribe();
  });
});

describe('WS11 local state scope fallback', () => {
  it('delivers global updates to an instance consumer like readiness', () => {
    const { bridgeKit } = setup();
    const binding = bridgeKit.provide(NumberState as BridgeContract<unknown>, {});
    const scope: BridgeScope = { kind: 'instance', feature: 'checkout', instance: 'cart-1' };
    const mirror = bridgeKit.state(NumberState as BridgeContract<unknown>, 'value', scope);
    const observed: number[] = [];
    const unsubscribe = mirror.subscribe((snapshot) => observed.push(snapshot.value as number));
    expect(bridgeKit.isProvided(NumberState as BridgeContract<unknown>, { scope })).toBe(true);
    binding.setState('value', 17);
    expect(observed).toEqual([17]);
    expect(mirror.get()).toEqual({ value: 17, status: 'provided' });
    unsubscribe();
  });
});
