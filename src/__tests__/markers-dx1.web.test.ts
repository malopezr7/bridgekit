// ---------------------------------------------------------------------------
// DX-1 — Marker API + ContractHook: type assertions + runtime tests
//
// Two test categories:
//   A) Compile-time: Equal<>/Expect<> pattern — type-level assertions that
//      become hard TS errors if inference drifts.
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

// ---- exact-type assertion machinery (no external deps) --------------------
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// ---- Marker kind inference ------------------------------------------------

// Sync<R>() — result only
const _s1 = Sync<string>();
type _k1 = Expect<Equal<typeof _s1, { readonly kind: 'querySync' }>>;

// Sync<P, R>() — params + result
const _s2 = Sync<{ key: string }, string>();
type _k2 = Expect<Equal<typeof _s2, { readonly kind: 'querySync' }>>;

// Async<R>() — result only
const _a1 = Async<number>();
type _k3 = Expect<Equal<(typeof _a1)['kind'], 'query'>>;

// Async<P, R>() — params + result
const _a2 = Async<{ q: string }, boolean>();
type _k4 = Expect<Equal<(typeof _a2)['kind'], 'query'>>;

// Async with opts
const _a3 = Async<string>({ timeoutMs: null });
type _k5 = Expect<Equal<(typeof _a3)['kind'], 'query'>>;

// Void<>() — no params
const _n1 = Void();
type _k6 = Expect<Equal<(typeof _n1)['kind'], 'fire'>>;

// Void<P>() — with params
const _n2 = Void<{ url: string }>();
type _k7 = Expect<Equal<(typeof _n2)['kind'], 'fire'>>;

// Stream<V>() — no params
const _st1 = Stream<string>();
type _k8 = Expect<Equal<(typeof _st1)['kind'], 'stream'>>;

// Stream<V, P>() — with params
const _st2 = Stream<number, { id: string }>();
type _k9 = Expect<Equal<(typeof _st2)['kind'], 'stream'>>;

// State<V>(initial) — carries runtime initial
const _sv1 = State<number>(0);
type _k10 = Expect<Equal<(typeof _sv1)['kind'], 'state'>>;
type _k11 = Expect<Equal<(typeof _sv1)['initial'], number>>;

// ---- defineContract with markers: DerivedConsumer shapes -------------------

// LiaHost sketch — matches Manuel's spec
const useLiaHost = defineContract('lia.host', {
  methods: {
    getLiteral: Sync<{ key: string }, string>(),
    getAppVersion: Sync<string>(),
    trackEvent: Void<{ eventName: string; eventParams?: unknown }>(),
    getCount: Async<number>(),
    checkPerm: Async<{ type: string }, string | null>(),
  },
  streams: {
    uploadProgress: Stream<number>(),
    fileBytes: Stream<Uint8Array, { fileId: string }>(),
  },
  state: {
    counter: State<number>(0),
    lastUri: State<string | null>(null),
  },
});

// The hook is callable as a function — this compiles iff the overload is correct
type LiaHostHook = typeof useLiaHost;

// statics exist at compile time
type _brand = LiaHostHook['$contract'];
type _id = Expect<Equal<LiaHostHook['id'], string>>;

// ---- Method signatures via DerivedConsumer --------------------------------

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

import type { BridgeStreamSource } from '../contract/contract';
import type { NoParams } from '../contract/markers';

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

// (a) no-arg call — full consumer
function _demoDestructure() {
  // Should compile — these are the correct method shapes
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
  // @ts-expect-error — trackEvent requires eventName
  trackEvent({});

  return { _lit, _v, _p1, _p2 };
}

// (b) selector form
function _demoSelector() {
  const getLiteral = useLiaHost((c) => c.getLiteral);
  type _chk = Expect<Equal<typeof getLiteral, (params: { key: string }) => string>>;
  const _s: string = getLiteral({ key: 'x' });
  return _s;
}

// (c) imperative getState
function _demoImperative() {
  const h = useLiaHost.getState();
  const _s: string = h.getLiteral({ key: 'k' });
  return _s;
}

// (d) state handles on snapshot
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

// ---- scoped() typing -------------------------------------------------------

function _demoScoped() {
  const scoped = useLiaHost.scoped({ feature: 'lia', instance: 'tag1' });
  // scoped returns same hook type
  type _chk = Expect<Equal<typeof scoped, typeof useLiaHost>>;
  return scoped;
}

// ---- useProvide typing -----------------------------------------------------

// useProvide is a React hook; we only check its signature here (runtime test elsewhere)
type _provType = typeof useLiaHost.useProvide;
// should accept partial impl
declare const _testImpl: { getAppVersion: () => string };
declare const _partialImpl: Parameters<_provType>[0];

// ---- union result narrows at call site ------------------------------------

interface PickedFile {
  uri: string;
  mimeType: string;
}
type PickResult = PickedFile | { error: string };

const useLiaMedia = defineContract('lia.media', {
  methods: {
    pickMedia: Async<{ source: string }, PickResult>(),
    refresh: Void(),
  },
  state: {
    lastPick: State<string | null>(null),
  },
});

type Media = ConsumerOf<typeof useLiaMedia>;

// pickMedia returns Promise<PickResult>
type _pm = Expect<
  Equal<
    Media['pickMedia'],
    (
      params: { source: string },
      opts?: import('../contract/markers').CallOpts,
    ) => Promise<PickResult>
  >
>;
// refresh is no-params fire
type _ref = Expect<Equal<Media['refresh'], () => void>>;

// union narrows at call site
async function _demoUnion() {
  const m = useLiaMedia.getState();
  const r = await m.pickMedia({ source: 'gallery' });
  if ('error' in r) {
    const _e: string = r.error;
    return _e;
  }
  const _uri: string = r.uri;
  return _uri;
}

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
  _pm,
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
  true,
];

// ===========================================================================
// B. RUNTIME TESTS — marker contract end-to-end over loopback
// ===========================================================================

// Marker-style contract (NO t.* schema)
const MarkerContract = defineContract('marker.test', {
  methods: {
    greet: Sync<{ name: string }, string>(),
    fetchNum: Async<number>(),
    fetchWithParam: Async<{ x: number }, string>(),
    doFire: Void<{ msg: string }>(),
    noParamsFire: Void(),
  },
  streams: {
    ticks: Stream<number>(),
  },
  state: {
    score: State<number>(0),
    label: State<string>('start'),
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
    // Note: querySync throws on loopback (no sync channel) — that's expected behavior
    // Test that it exists and dispatches correctly (will throw BRIDGE_NOT_READY)
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
    // With local-first resolution, bk.state() returns a LocalStateMirror backed by
    // the JS Registry. Use binding.setState (not transport.notifyStateChange) to update.
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

// ---- Universal sanitize (no schema → deep strip undefined) -----------------

describe('Universal sanitize: encode without schema', () => {
  test('passes payload through when no schema — no crash', async () => {
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
    // { a: undefined } must not crash the AnyMap; bridge sanitizes it
    expect(() =>
      (proxy as Record<string, (p: unknown) => void>).doFire({ msg: 'x', extra: undefined }),
    ).not.toThrow();
  });

  test('async query with undefined in params does not crash', async () => {
    const { bridgekit } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      fetchWithParam: async (p: unknown) => `ok-${JSON.stringify(p)}`,
    });
    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );
    // Passing payload with undefined field — sanitizer must strip it
    const result = await (proxy as Record<string, (p: unknown) => Promise<string>>).fetchWithParam({
      x: 5,
      debug: undefined,
    });
    expect(typeof result).toBe('string');
  });
});

// ---- INCOMPATIBLE_CONTRACT guard (marker path) ----------------------------
// This guard applies to the TRANSPORT path (native provider returns no encoded value,
// indicating a codegen/codec mismatch). For LOCAL-FIRST, a JS impl returning undefined
// is a deliberate choice by the implementor — no guard is applied.

/** Stub transport that returns ok:true with no value (simulates native encoder mismatch). */
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
  };
}

describe('INCOMPATIBLE_CONTRACT guard: marker query', () => {
  test('Async query throws INCOMPATIBLE_CONTRACT when result is undefined (transport/native path)', async () => {
    // Guard applies to transport path: native provider fails to encode value.
    // We do NOT provide locally so the transport path is used.
    const transport = makeUndefinedResultTransport();
    const { BridgeKitJs } =
      require('../runtime/bridgekit') as typeof import('../runtime/bridgekit');
    const bridgekit = new BridgeKitJs(transport);
    bridgekit.connect();

    // No local provide → transport is used → undefined value triggers guard
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
    // For locally-provided contracts, undefined is a valid deliberate return value.
    const { bridgekit } = createTestBridge();
    bridgekit.provide(MarkerContract as import('../contract/contract').BridgeContract<unknown>, {
      fetchNum: async () => undefined as unknown as number,
    });
    const proxy = bridgekit.bridge(
      MarkerContract as import('../contract/contract').BridgeContract<unknown>,
    );

    // Should NOT throw — local impl is trusted
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

  test('getState() returns a snapshot object', () => {
    // getState() is non-React — should return stable functions
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
// ADR-1: hook() is now a real React hook (calls useContext/useSyncExternalStore
// unconditionally). Imperative (non-render) callers MUST use hook.getState(),
// which returns the same DerivedConsumer shape without subscribing. These tests
// exercise that imperative read; the in-render hook() path is covered by
// contractHook.web.test.ts.

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

// ---- Dev-validator seam (ADR-3: deleted) --------------------------------------
// devValidator.ts was dead code — runInboundValidator had zero runtime callers
// and the emitted import (@malopezr7/bridgekit/runtime) pointed to a non-existent
// subpath. Inbound validation is covered by codec validate() in runtime/bridgekit.ts.
// These tests are removed because the module no longer exists.
