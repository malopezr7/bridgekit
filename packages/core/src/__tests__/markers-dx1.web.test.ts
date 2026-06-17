// ---------------------------------------------------------------------------
// DX-1 — Schema-first Marker API + ContractHook: type assertions + runtime tests
//
// W3 rewrite: markers now take t.* schema values (design D1).
// Phantom generics, NoParams sentinel, and .bridge.ts re-injection are gone.
//
// Two test categories:
//   A) Compile-time: Equal<>/Expect<> pattern — type-level assertions.
//   B) Runtime: marker contract end-to-end over createTestBridge() loopback.
// ---------------------------------------------------------------------------

import { describe, expect, test } from '@jest/globals';
import { defineContract, t } from '../contract/contract';
import { Async, State, Stream, Sync, Void } from '../contract/markers';
import { GLOBAL_SCOPE, streamSource } from '../runtime/registry';
import { createTestBridge } from '../testing/index';

// ===========================================================================
// A. COMPILE-TIME TYPE ASSERTIONS
// ===========================================================================

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// ---- Descriptor kind inference ------------------------------------------------

// Sync(result) — result only
const _s1 = Sync(t.string());
type _k1 = Expect<Equal<(typeof _s1)['kind'], 'querySync'>>;

// Sync(params, result) — params + result
const _s2 = Sync(t.object({ key: t.string() }), t.string());
type _k2 = Expect<Equal<(typeof _s2)['kind'], 'querySync'>>;

// Async(result) — result only
const _a1 = Async(t.number());
type _k3 = Expect<Equal<(typeof _a1)['kind'], 'query'>>;

// Async(params, result) — params + result
const _a2 = Async(t.object({ q: t.string() }), t.boolean());
type _k4 = Expect<Equal<(typeof _a2)['kind'], 'query'>>;

// Async with opts
const _a3 = Async(t.string(), { timeoutMs: null });
type _k5 = Expect<Equal<(typeof _a3)['kind'], 'query'>>;

// Void() — no params
const _n1 = Void();
type _k6 = Expect<Equal<(typeof _n1)['kind'], 'fire'>>;

// Void(params) — with params
const _n2 = Void(t.object({ url: t.string() }));
type _k7 = Expect<Equal<(typeof _n2)['kind'], 'fire'>>;

// Stream(value) — no params
const _st1 = Stream(t.string());
type _k8 = Expect<Equal<(typeof _st1)['kind'], 'stream'>>;

// Stream(value, params) — with params
const _st2 = Stream(t.number(), t.object({ id: t.string() }));
type _k9 = Expect<Equal<(typeof _st2)['kind'], 'stream'>>;

// State(value, initial) — carries runtime initial
const _sv1 = State(t.number(), 0);
type _k10 = Expect<Equal<(typeof _sv1)['kind'], 'state'>>;
type _k11 = Expect<Equal<(typeof _sv1)['initial'], number>>;

// ---- defineContract with schema-first markers: DerivedConsumer shapes ------

const useLiaHost = defineContract('lia.host', {
  methods: {
    getLiteral: Sync(t.object({ key: t.string() }), t.string()),
    getAppVersion: Sync(t.string()),
    trackEvent: Void(t.object({ eventName: t.string(), eventParams: t.optional(t.json()) })),
    getCount: Async(t.number()),
    checkPerm: Async(t.object({ type: t.string() }), t.nullable(t.string())),
  },
  streams: {
    uploadProgress: Stream(t.number()),
    fileBytes: Stream(t.binary(), t.object({ fileId: t.string() })),
  },
  state: {
    counter: State(t.number(), 0),
    lastUri: State(t.nullable(t.string()), null),
  },
});

type LiaHostHook = typeof useLiaHost;

type _brand = LiaHostHook['$contract'];
type _id = Expect<Equal<LiaHostHook['id'], string>>;

// ---- Method signatures via DerivedConsumer --------------------------------

import type { BridgeStreamSource } from '../contract/contract';
import type { ConsumerOf } from '../contract/markers';

type H = ConsumerOf<typeof useLiaHost>;

// querySync with params
type _ms1 = Expect<Equal<H['getLiteral'], (params: { key: string }) => string>>;
// querySync result-only
type _ms2 = Expect<Equal<H['getAppVersion'], () => string>>;
// fire with params
type _ms3 = Expect<
  Equal<H['trackEvent'], (params: { eventName: string; eventParams?: unknown }) => void>
>;
// query result-only
type _ms4 = Expect<
  Equal<H['getCount'], (opts?: import('../contract/markers').CallOpts) => Promise<number>>
>;
// query with params (nullable result)
type _ms5 = Expect<
  Equal<
    H['checkPerm'],
    (
      params: { type: string },
      opts?: import('../contract/markers').CallOpts,
    ) => Promise<string | null>
  >
>;

// ---- Streams ---------------------------------------------------------------

// stream no params
type _str1 = Expect<Equal<H['uploadProgress'], () => BridgeStreamSource<number>>>;
// stream with params
type _str2 = Expect<
  Equal<H['fileBytes'], (params: { fileId: string }) => BridgeStreamSource<Uint8Array>>
>;

// ---- State -----------------------------------------------------------------

type _stv1 = Expect<
  Equal<H['state']['counter'], import('../contract/markers').StateHandle<number>>
>;
type _stv2 = Expect<
  Equal<H['state']['lastUri'], import('../contract/markers').StateHandle<string | null>>
>;

// ---- Zustand hook overloads ------------------------------------------------

function _demoDestructure() {
  const { getLiteral, getAppVersion, trackEvent, getCount, checkPerm } = useLiaHost();
  const _lit: string = getLiteral({ key: 'welcome' });
  const _v: string = getAppVersion();
  trackEvent({ eventName: 'open' });
  const _p1: Promise<number> = getCount();
  const _p2: Promise<string | null> = checkPerm({ type: 'camera' });

  // @ts-expect-error — getLiteral REQUIRES params
  getLiteral();
  // @ts-expect-error — getAppVersion takes no params
  getAppVersion({ x: 1 });

  return { _lit, _v, _p1, _p2 };
}

function _demoSelector() {
  const getLiteral = useLiaHost((c) => c.getLiteral);
  type _chk = Expect<Equal<typeof getLiteral, (params: { key: string }) => string>>;
  const _s: string = getLiteral({ key: 'x' });
  return _s;
}

function _demoImperative() {
  const h = useLiaHost.getState();
  const _s: string = h.getLiteral({ key: 'k' });
  return _s;
}

function _demoState() {
  const { state } = useLiaHost();
  const _cur: number = state.counter.get();
  const _unsub = state.counter.subscribe((v) => {
    const _n: number = v;
    return _n;
  });
  _unsub();
  return _cur;
}

function _demoScoped() {
  const scoped = useLiaHost.scoped({ feature: 'lia', instance: 'tag1' });
  type _chk = Expect<Equal<typeof scoped, typeof useLiaHost>>;
  return scoped;
}

type _provType = typeof useLiaHost.useProvide;
declare const _partialImpl: Parameters<_provType>[0];

// ---- union result narrows at call site ------------------------------------

interface PickedFile {
  uri: string;
  mimeType: string;
}
type PickResult = PickedFile | { error: string };

const useLiaMedia = defineContract('lia.media', {
  methods: {
    pickMedia: Async(
      t.object({ source: t.string() }),
      t.json() as import('../contract/schema').AnySchema as import('../contract/contract').QueryDescriptor['result'],
    ),
    refresh: Void(),
  },
  state: {
    lastPick: State(t.nullable(t.string()), null),
  },
});

type Media = ConsumerOf<typeof useLiaMedia>;

// refresh is no-params fire
type _ref = Expect<Equal<Media['refresh'], () => void>>;

// Collect all assertion types so noUnusedLocals wouldn't fire (if on)
export const _assertions: [
  _k1,
  _k2,
  _k3,
  _k4,
  _k5,
  _k6,
  _k7,
  _k8,
  _k9,
  _k10,
  _k11,
  _ms1,
  _ms2,
  _ms3,
  _ms4,
  _ms5,
  _str1,
  _str2,
  _stv1,
  _stv2,
  _id,
  _ref,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

// ===========================================================================
// B. RUNTIME TESTS — schema-first marker contract end-to-end over loopback
// ===========================================================================

// Schema-first contract (t.* schema values)
const MarkerContract = defineContract('marker.test', {
  methods: {
    greet: Sync(t.object({ name: t.string() }), t.string()),
    fetchNum: Async(t.number()),
    fetchWithParam: Async(t.object({ x: t.number() }), t.string()),
    doFire: Void(t.object({ msg: t.string() })),
    noParamsFire: Void(),
  },
  streams: {
    ticks: Stream(t.number()),
  },
  state: {
    score: State(t.number(), 0),
    label: State(t.string(), 'start'),
  },
});

// Legacy t.* contract — must keep working unchanged
const LegacyContract = defineContract('legacy.test', {
  methods: {
    ping: t.query(t.string()),
    echo: t.query(t.object({ msg: t.string() }), t.string()),
    syncNum: t.querySync(t.number()),
  },
  streams: {
    nums: t.stream(t.number()),
  },
  state: {
    count: t.state(t.number(), 0),
  },
});

// ---- Marker contract: querySync --------------------------------------------

describe('Marker contract: querySync (Sync)', () => {
  test('returns value via loopback', () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      greet: (p: unknown) => `Hello ${(p as { name: string }).name}`,
    });
    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );
    expect(typeof (proxy as Record<string, unknown>).greet).toBe('function');
  });
});

// ---- Marker contract: async query ------------------------------------------

describe('Marker contract: async query (Async)', () => {
  test('fetchNum (no params) returns value', async () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      fetchNum: async () => 42,
    });
    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );
    const result = await (proxy as Record<string, () => Promise<number>>).fetchNum();
    expect(result).toBe(42);
  });

  test('fetchWithParam passes params through', async () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      fetchWithParam: async (p: unknown) => `x=${(p as { x: number }).x}`,
    });
    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );
    const result = await (
      proxy as Record<string, (p: { x: number }) => Promise<string>>
    ).fetchWithParam({ x: 7 });
    expect(result).toBe('x=7');
  });
});

// ---- Marker contract: fire -------------------------------------------------

describe('Marker contract: fire (Void)', () => {
  test('doFire does not throw', () => {
    const { bridgekit } = createTestBridge();
    const received: unknown[] = [];
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      doFire: (p: unknown) => {
        received.push(p);
      },
    });
    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );
    expect(() =>
      (proxy as Record<string, (p: unknown) => void>).doFire({ msg: 'hi' }),
    ).not.toThrow();
  });

  test('noParamsFire does not throw', () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      noParamsFire: () => {},
    });
    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );
    expect(() => (proxy as Record<string, () => void>).noParamsFire()).not.toThrow();
  });
});

// ---- Marker contract: stream -----------------------------------------------

describe('Marker contract: stream (Stream)', () => {
  test('multi-value stream via loopback', async () => {
    const { bridgekit, transport } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      ticks: () =>
        streamSource<number>((emit, end) => {
          emit(1);
          emit(2);
          emit(3);
          end();
          return () => {};
        }),
    });

    const received: number[] = [];
    const env = {
      op: 'streamOpen' as const,
      contractId: 'marker.test',
      member: 'ticks',
      scope: GLOBAL_SCOPE,
      correlationId: 'mst1',
      epoch: 1,
    };

    await new Promise<void>((resolve) => {
      transport.openStream(
        env,
        (v) => received.push(v as number),
        (_end) => resolve(),
      );
    });

    expect(received).toEqual([1, 2, 3]);
  });
});

// ---- Marker contract: state initial + reactive snapshot -------------------

describe('Marker contract: state (State)', () => {
  test('initial value from marker', () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {});
    const mirror = bridgekit.state(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
      'score',
    );
    expect(mirror.get().value).toBe(0);
  });

  test('label initial from marker', () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {});
    const mirror = bridgekit.state(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
      'label',
    );
    expect(mirror.get().value).toBe('start');
  });

  test('state update propagates to mirror (local-first: via binding.setState)', async () => {
    const { bridgekit } = createTestBridge();
    const binding = bridgekit.provide(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
      {},
    );
    const mirror = bridgekit.state(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
      'score',
    );
    const values: unknown[] = [];
    const unsub = mirror.subscribe((mv) => values.push(mv.value));
    await new Promise((r) => setTimeout(r, 10));

    binding.setState('score', 99);
    await new Promise((r) => setTimeout(r, 10));
    unsub();

    expect(values.some((v) => v === 99)).toBe(true);
  });
});

// ---- Universal sanitize (schema present → codec encode) --------------------

describe('Universal sanitize: encode with schema', () => {
  test('passes payload through without crash', async () => {
    const { bridgekit } = createTestBridge();
    const received: unknown[] = [];
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      doFire: (p: unknown) => {
        received.push(p);
      },
    });
    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );
    expect(() =>
      (proxy as Record<string, (p: unknown) => void>).doFire({ msg: 'x' }),
    ).not.toThrow();
  });

  test('async query with params does not crash', async () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      fetchWithParam: async (p: unknown) => `ok-${JSON.stringify(p)}`,
    });
    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );
    const result = await (proxy as Record<string, (p: unknown) => Promise<string>>).fetchWithParam({
      x: 5,
    });
    expect(typeof result).toBe('string');
  });
});

// ---- INCOMPATIBLE_CONTRACT guard (schema-first path) ----------------------

function makeUndefinedResultTransport(): import('../runtime/transport').BridgeTransport {
  return {
    connect: () => ({ epoch: 1, snapshot: [] }),
    invoke: () => Promise.resolve({ ok: true, value: undefined }),
    invokeSync: () => ({ ok: true, value: undefined }),
    openStream: () => 'sid',
    closeStream: () => {},
    emitFromJs: () => {},
    endFromJs: () => {},
    stateRead: () => ({ ok: true, value: undefined }),
    stateObserve: () => 'obs',
    stateUnobserve: () => {},
    stateWrite: () => ({ ok: true }),
    pushProviderState: () => {},
    announceProvided: () => {},
    announceUnprovided: () => {},
  };
}

describe('INCOMPATIBLE_CONTRACT guard: schema-first query', () => {
  test('Async query throws INCOMPATIBLE_CONTRACT when result is undefined (transport/native path)', async () => {
    const transport = makeUndefinedResultTransport();
    const { BridgeKitJs } =
      require('../runtime/bridgekit') as typeof import('../runtime/bridgekit');
    const bridgekit = new BridgeKitJs(transport);
    bridgekit.connect();

    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );

    let caughtCode: string | undefined;
    try {
      await (proxy as Record<string, () => Promise<unknown>>).fetchNum();
    } catch (e) {
      caughtCode = (e as Record<string, string>).code;
    }
    expect(caughtCode).toBe('INCOMPATIBLE_CONTRACT');
  });

  test('Local-first: JS impl returning undefined is valid (no INCOMPATIBLE_CONTRACT guard)', async () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      fetchNum: async () => undefined as unknown as number,
    });
    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );

    const result = await (proxy as Record<string, () => Promise<unknown>>).fetchNum();
    expect(result).toBeUndefined();
  });

  test('Void (fire) does NOT throw INCOMPATIBLE_CONTRACT for undefined result', () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      noParamsFire: () => undefined,
    });
    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );
    expect(() => (proxy as Record<string, () => void>).noParamsFire()).not.toThrow();
  });
});

// ---- ContractHook: getState + scoped + useProvide -------------------------

describe('ContractHook: statics and getState', () => {
  test('id is the contract id string', () => {
    expect(useLiaHost.id).toBe('lia.host');
  });

  test('$descriptor contains kinds for all members', () => {
    expect(useLiaHost.$descriptor.methods.getLiteral?.kind).toBe('querySync');
    expect(useLiaHost.$descriptor.methods.trackEvent?.kind).toBe('fire');
    expect(useLiaHost.$descriptor.methods.getCount?.kind).toBe('query');
    expect(useLiaHost.$descriptor.streams.uploadProgress?.kind).toBe('stream');
    expect(useLiaHost.$descriptor.state.counter?.kind).toBe('state');
    expect(useLiaHost.$descriptor.state.counter?.initial).toBe(0);
  });

  test('$contract brand exists', () => {
    expect((useLiaHost as Record<string, unknown>).$contract).toBe('io.github.malopezr7.bridgekit.contract');
  });

  test('hash is a non-empty string', () => {
    expect(typeof useLiaHost.hash).toBe('string');
    expect(useLiaHost.hash.length).toBeGreaterThan(0);
  });

  test('descriptor matches BridgeContract shape for codegen', () => {
    const d = useLiaHost.descriptor;
    expect(d.$type).toBe('io.github.malopezr7.bridgekit.contract');
    expect(d.descriptorVersion).toBe(1);
    expect(d.id).toBe('lia.host');
  });

  test('descriptor carries schema nodes (schema-first)', () => {
    const d = useLiaHost.descriptor;
    // Verify method descriptors carry schema nodes
    expect(d.methods.getLiteral.result).toEqual({ kind: 'string' });
    expect(
      (d.methods.getLiteral as import('../contract/contract').QuerySyncWithParamsDescriptor).params,
    ).toEqual({
      kind: 'object',
      fields: { key: { kind: 'string' } },
    });
    expect(d.state.counter.value).toEqual({ kind: 'number' });
    expect(d.streams.uploadProgress.value).toEqual({ kind: 'number' });
  });

  test('getState() returns a snapshot object', () => {
    const snap = useLiaHost.getState();
    expect(typeof snap.getLiteral).toBe('function');
    expect(typeof snap.trackEvent).toBe('function');
    expect(snap.state).toBeDefined();
  });

  test('scoped() returns a new ContractHook with same id', () => {
    const scoped = useLiaHost.scoped({ feature: 'lia', instance: 'tag1' });
    expect(scoped.id).toBe('lia.host');
    expect(typeof scoped).toBe('function');
    expect(typeof scoped.getState).toBe('function');
    expect(typeof scoped.scoped).toBe('function');
  });

  test('useProvide is a function', () => {
    expect(typeof useLiaHost.useProvide).toBe('function');
  });
});

// ---- ContractHook imperative snapshot: shape + state handles --------------

describe('ContractHook imperative snapshot (getState)', () => {
  test('getState() returns snapshot with methods', () => {
    const snap = useLiaHost.getState();
    expect(typeof snap.getLiteral).toBe('function');
    expect(typeof snap.getAppVersion).toBe('function');
    expect(typeof snap.trackEvent).toBe('function');
    expect(snap.state).toBeDefined();
  });

  test('selector applied to getState() returns the selected slice', () => {
    const fn = useLiaHost.getState().getLiteral;
    expect(typeof fn).toBe('function');
  });

  test('state handles on snapshot: get() returns initial value', () => {
    const snap = useLiaHost.getState();
    expect(snap.state.counter.get()).toBe(0);
    expect(snap.state.lastUri.get()).toBeNull();
  });

  test('state handles: subscribe returns unsubscribe function', () => {
    const snap = useLiaHost.getState();
    const unsub = snap.state.counter.subscribe((_v) => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });
});

// ---- Coexistence: legacy t.* contract still works -------------------------

describe('Coexistence: legacy t.* contract unchanged', () => {
  test('t.query round trip', async () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(LegacyContract as import('../contract/contract').BridgeContract<unknown>, {
      ping: async () => 'pong',
    });
    const proxy = bridgekit.bridge(
      LegacyContract as import('../contract/contract').BridgeContract<unknown>,
    );
    const result = await (proxy as Record<string, () => Promise<string>>).ping();
    expect(result).toBe('pong');
  });

  test('t.query with params', async () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(LegacyContract as import('../contract/contract').BridgeContract<unknown>, {
      echo: async (p: unknown) => (p as { msg: string }).msg.toUpperCase(),
    });
    const proxy = bridgekit.bridge(
      LegacyContract as import('../contract/contract').BridgeContract<unknown>,
    );
    const result = await (proxy as Record<string, (p: { msg: string }) => Promise<string>>).echo({
      msg: 'hello',
    });
    expect(result).toBe('HELLO');
  });

  test('t.stream still works', async () => {
    const { bridgekit, transport } = createTestBridge();
    bridgekit.provide(LegacyContract as import('../contract/contract').BridgeContract<unknown>, {
      nums: () =>
        streamSource<number>((emit, end) => {
          emit(10);
          emit(20);
          end();
          return () => {};
        }),
    });
    const received: number[] = [];
    const env = {
      op: 'streamOpen' as const,
      contractId: 'legacy.test',
      member: 'nums',
      scope: GLOBAL_SCOPE,
      correlationId: 'lst1',
      epoch: 1,
    };
    await new Promise<void>((resolve) => {
      transport.openStream(
        env,
        (v) => received.push(v as number),
        () => resolve(),
      );
    });
    expect(received).toEqual([10, 20]);
  });

  test('t.state initial from descriptor', () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(LegacyContract as import('../contract/contract').BridgeContract<unknown>, {});
    const mirror = bridgekit.state(
      LegacyContract as import('../contract/contract').BridgeContract<unknown>,
      'count',
    );
    expect(mirror.get().value).toBe(0);
  });
});
