// ---------------------------------------------------------------------------
// ContractHook keystone tests (jsdom / @testing-library/react) — ADR-1, ADR-2.
//
// These tests are regression-first: each was authored to FAIL against the
// pre-fix ContractHook (render-detection via React private internals, which
// does not exist on React 19 → the hook never subscribed and useProvide forced
// global scope), then PASS once ContractHook calls its React hooks
// unconditionally and useProvide honours ScopeContext.
//
// ADR-1: hook() IS the React hook — calls useContext/useMemo/useSyncExternalStore
//        unconditionally; re-renders when a bound state mirror changes.
//        hook.getState() stays the separate imperative (non-hook) read.
// ADR-2: hook.useProvide() registers into the ScopeContext scope, not global,
//        unless an explicit .scoped() override was set.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { BridgeScopeProvider } from '../../react/hooks';
import { getDefaultBridgeKit } from '../../runtime/defaultInstance';
import type { Binding } from '../../runtime/registry';
import { GLOBAL_SCOPE } from '../../runtime/registry';
import { defineContract, t } from '../contract';
import { Async } from '../markers';

// ---------------------------------------------------------------------------
// Synthetic contracts — unique IDs per file to avoid cross-test pollution.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScopeWrapper(feature?: string, instance?: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(BridgeScopeProvider, { feature, instance }, children);
  };
}

// ---------------------------------------------------------------------------
// ADR-1 — ContractHook real subscription
// ---------------------------------------------------------------------------

describe('ADR-1: ContractHook real subscription via useSyncExternalStore', () => {
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
    // JS-provide so the hook resolves a LocalStateMirror backed by the registry.
    binding = bk.provide(SubscriptionContract, {}, { scope: GLOBAL_SCOPE });

    // Capture the value the hook returns ON EACH RENDER (read during render — not
    // at assert time — so a missing subscription leaves the captured value stale).
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

    // Push a new value through the binding — fans out to the local mirror.
    await act(async () => {
      binding?.setState('count', 42);
    });

    // FAILS on pre-fix code: hook never subscribes, so no re-render is triggered
    // and the last value captured during render stays 0.
    expect(observedValues.length).toBeGreaterThan(rendersBefore);
    expect(observedValues[observedValues.length - 1]).toBe(42);
    expect(result.current).toBe(42);

    unmount();
  });

  test('hook.getState() returns a snapshot without a React render context', () => {
    // Guard for the imperative split (ADR-1): getState() must work with NO React
    // render on the stack. PASSES on both pre-fix and post-fix code.
    binding = bk.provide(SubscriptionContract, {}, { scope: GLOBAL_SCOPE });
    binding.setState('count', 7);

    const snapshot = SubscriptionContract.getState() as {
      state: Record<string, { get: () => unknown }>;
    };

    expect(snapshot.state.count?.get()).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// ADR-2 — useProvide honours ScopeContext
// ---------------------------------------------------------------------------

describe('ADR-2: hook.useProvide registers into provider scope, not global', () => {
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

    // FAILS on pre-fix code: useProvide forces _getScopeImperative() (global)
    // → the binding lands in 'global', not 'feature:f1'.
    expect(inFeature).toBeDefined();
    expect(inGlobal).toBeUndefined();

    unmount();
  });

  test('useProvide with explicit .scoped() keeps the explicit scope over context', () => {
    // Explicit override must always win (ADR-2 contract). Mounted inside feature
    // 'ctx' but scoped to feature 'explicit' → registers in 'explicit'.
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
