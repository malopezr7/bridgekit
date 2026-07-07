// ContractHook keystone tests (jsdom / @testing-library/react).
// hook() calls React hooks unconditionally and re-renders on state change.
// hook.useProvide() registers into the ScopeContext scope unless .scoped() overrides it.

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { BridgeScopeProvider } from '../../react/hooks';
import { getDefaultBridgeKit } from '../../runtime/defaultInstance';
import type { Binding } from '../../runtime/registry';
import { GLOBAL_SCOPE } from '../../runtime/registry';
import { defineContract, t } from '../contract';
import { Async } from '../markers';

// Unique contract IDs per file to avoid cross-test pollution.

const SubscriptionContract = defineContract('contract-hook.subscription.test', {
  methods: {
    ping: Async(t.string()),
  },
  state: {
    count: t.state(t.number(), 0),
  },
});

const ProvideScopeContract = defineContract('contract-hook.provide-scope.test', {
  methods: {
    ping: Async(t.string()),
  },
  state: {
    value: t.state(t.string(), 'initial'),
  },
});

const ProtoHardenedContract = defineContract('contract-hook.proto-hardened.test', {
  methods: (() => {
    const methods: Record<string, ReturnType<typeof Async>> = Object.create(null);
    methods.safeMethod = Async(t.string());
    Reflect.set(methods, '__proto__', Async(t.string()));
    Reflect.set(methods, 'constructor', Async(t.string()));
    Reflect.set(methods, 'prototype', Async(t.string()));
    return methods;
  })(),
  state: (() => {
    const state: Record<string, ReturnType<typeof t.state>> = Object.create(null);
    state.safeState = t.state(t.string(), 'initial');
    Reflect.set(state, '__proto__', t.state(t.string(), 'polluted'));
    Reflect.set(state, 'constructor', t.state(t.string(), 'ctor'));
    Reflect.set(state, 'prototype', t.state(t.string(), 'proto'));
    return state;
  })(),
});

function makeScopeWrapper(feature?: string, instance?: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(BridgeScopeProvider, { feature, instance }, children);
  };
}

describe('ContractHook real subscription via useSyncExternalStore', () => {
  let binding: Binding | null = null;
  const bk = getDefaultBridgeKit();

  beforeEach(() => {
    binding = null;
  });

  afterEach(() => {
    if (binding) {
      try {
        binding.close('final');
      } catch {
        /* ignore */
      }
      binding = null;
    }
  });

  test('hook() re-renders with the new value when the StateStore emits', async () => {
    binding = bk.provide(SubscriptionContract, {}, { scope: GLOBAL_SCOPE });

    // Capture value on each render (not at assert time) to detect missing subscription.
    const observedValues: number[] = [];

    const { result, unmount } = renderHook(() => {
      const snap = SubscriptionContract() as {
        state: Record<string, { get: () => unknown }>;
      };
      const value = snap.state.count?.get() as number;
      observedValues.push(value);
      return value;
    });

    expect(result.current).toBe(0);
    const rendersBefore = observedValues.length;

    await act(async () => {
      binding?.setState('count', 42);
    });

    expect(observedValues.length).toBeGreaterThan(rendersBefore);
    expect(observedValues[observedValues.length - 1]).toBe(42);
    expect(result.current).toBe(42);

    unmount();
  });

  test('hook.getState() returns a snapshot without a React render context', () => {
    binding = bk.provide(SubscriptionContract, {}, { scope: GLOBAL_SCOPE });
    binding.setState('count', 7);

    const snapshot = SubscriptionContract.getState() as {
      state: Record<string, { get: () => unknown }>;
    };

    expect(snapshot.state.count?.get()).toBe(7);
  });
});

describe('hook.useProvide registers into ScopeContext scope, not global', () => {
  const bk = getDefaultBridgeKit();
  const bindings: Binding[] = [];

  afterEach(() => {
    for (const b of bindings.splice(0)) {
      try {
        b.close('final');
      } catch {
        /* ignore */
      }
    }
  });

  test('useProvide inside a feature ScopeProvider registers in feature scope, not global', () => {
    const Wrapper = makeScopeWrapper('f1');
    const impl = { ping: async () => 'pong' };

    const { unmount } = renderHook(() => ProvideScopeContract.useProvide(impl), {
      wrapper: Wrapper,
    });

    const dump = bk.registry.dump();
    const id = ProvideScopeContract.id as string;

    const inFeature = dump.find(
      (b) => b.contractId === id && b.scopeKey === 'feature:f1' && b.isLive,
    );
    const inGlobal = dump.find((b) => b.contractId === id && b.scopeKey === 'global' && b.isLive);

    expect(inFeature).toBeDefined();
    expect(inGlobal).toBeUndefined();

    unmount();
  });

  test('useProvide with explicit .scoped() keeps the explicit scope over context', () => {
    const Wrapper = makeScopeWrapper('ctx');
    const impl = { ping: async () => 'pong' };
    const scopedHook = ProvideScopeContract.scoped({ feature: 'explicit' });

    const { unmount } = renderHook(() => scopedHook.useProvide(impl), {
      wrapper: Wrapper,
    });

    const dump = bk.registry.dump();
    const id = ProvideScopeContract.id as string;

    const inExplicit = dump.find(
      (b) => b.contractId === id && b.scopeKey === 'feature:explicit' && b.isLive,
    );
    const inCtx = dump.find((b) => b.contractId === id && b.scopeKey === 'feature:ctx' && b.isLive);

    expect(inExplicit).toBeDefined();
    expect(inCtx).toBeUndefined();

    unmount();
  });
});

describe('codec_web_record_proto_payload_does_not_mutate_prototype', () => {
  test('hook.getState() skips guarded authored keys without mutating snapshot prototypes', () => {
    const snapshot = ProtoHardenedContract.getState() as {
      safeMethod?: unknown;
      state: Record<string, unknown>;
    };

    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.getPrototypeOf(snapshot.state)).toBeNull();
    expect(snapshot.safeMethod).toBeDefined();
    expect(snapshot.state.safeState).toBeDefined();
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(Object.hasOwn(snapshot, key)).toBe(false);
      expect(Object.hasOwn(snapshot.state, key)).toBe(false);
    }
  });
});
