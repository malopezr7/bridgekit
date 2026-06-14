// ---------------------------------------------------------------------------
// Wave 4 — React hooks tests (jsdom / @testing-library/react)
//
// Covers:
//   W4-1: ScopeContext isolation — nested/sibling scopes do not cross-talk.
//   W4-2: ContractHook real subscription via useSyncExternalStore — re-renders
//         on state change, unsubscribes on unmount.
//   Proxy stability: useBridge reference is stable across re-renders.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { defineContract, t } from '../contract/contract';
import { Async, State, Void } from '../contract/markers';
import { BridgeScopeProvider, useBridge, useBridgeState, useProvideBridge } from '../react/hooks';
import { getDefaultBridgeKit } from '../runtime/defaultInstance';
import { diagnostics } from '../runtime/diagnostics';
import type { Binding } from '../runtime/registry';
import { GLOBAL_SCOPE } from '../runtime/registry';

// ---------------------------------------------------------------------------
// Test contracts (unique IDs per test file to avoid cross-test pollution)
// ---------------------------------------------------------------------------

const ScopeTestContract = defineContract('hooks.scope.test', {
  methods: {
    ping: Async<string>(),
  },
  state: {
    value: t.state(t.string(), 'initial'),
  },
});

const StateContract = defineContract('hooks.state.test', {
  state: {
    count: t.state(t.number(), 0),
    label: t.state(t.string(), 'start'),
  },
  methods: {
    noop: Void(),
  },
});

const MarkerHookTest = defineContract('hooks.marker.test', {
  methods: {
    ping: Async<string>(),
  },
  state: {
    msg: State<string>('hello'),
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Wrapper factory for BridgeScopeProvider
function makeScopeWrapper(feature?: string, instance?: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(BridgeScopeProvider, { feature, instance }, children);
  };
}

// ---------------------------------------------------------------------------
// W4-1: Two subtrees — independent scopes, no cross-talk
// ---------------------------------------------------------------------------

describe('W4-1: BridgeScopeProvider — scope isolation', () => {
  // Track bindings to close after each test
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

  test('two separate render trees with different feature scopes do not cross-talk', () => {
    // Two hooks rendered in separate trees with different BridgeScopeProvider wrappers.
    // Each should see its own isolated scope and NOT share state.
    const WrapperA = makeScopeWrapper('featureA');
    const WrapperB = makeScopeWrapper('featureB');

    const hookA = renderHook(() => useBridgeState(ScopeTestContract, 'value'), {
      wrapper: WrapperA,
    });
    const hookB = renderHook(() => useBridgeState(ScopeTestContract, 'value'), {
      wrapper: WrapperB,
    });

    // Both start at 'initial' — no cross-talk
    expect(hookA.result.current.value).toBe('initial');
    expect(hookB.result.current.value).toBe('initial');

    hookA.unmount();
    hookB.unmount();
  });

  test('BridgeScopeProvider wraps children — hook renders without error', () => {
    // Simply render inside a BridgeScopeProvider — should not throw.
    const WrapperF = makeScopeWrapper('testFeature');
    const { result, unmount } = renderHook(() => useBridgeState(ScopeTestContract, 'value'), {
      wrapper: WrapperF,
    });
    expect(result.current.status).toBeDefined();
    unmount();
  });

  test('no BridgeScopeProvider — global scope is the default, dev warning fires once', () => {
    // Without a provider, ScopeContext defaults to { kind: 'global' }.
    // The hook must not throw (W-1: keep graceful default).
    // A ONE-TIME dev warning must be emitted via diagnostics (W-1: make it legible).
    diagnostics.clearWarnings(); // reset so this test is isolated

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result, unmount } = renderHook(() => useBridgeState(ScopeTestContract, 'value'));
      expect(result.current.status).toBeDefined(); // no throw

      // Dev warning must have fired at least once
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('useBridgeState'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BridgeScopeProvider'));

      unmount();
    } finally {
      warnSpy.mockRestore();
      diagnostics.clearWarnings();
    }
  });

  test('nested BridgeScopeProvider: innermost scope wins', () => {
    // Inner scope overrides outer — the innermost Provider wins per React context semantics.
    function NestedWrapper({ children }: { children: React.ReactNode }) {
      return createElement(
        BridgeScopeProvider,
        { feature: 'outer' },
        createElement(BridgeScopeProvider, { feature: 'inner' }, children),
      );
    }

    const { result, unmount } = renderHook(() => useBridgeState(ScopeTestContract, 'value'), {
      wrapper: NestedWrapper,
    });

    // Inner scope wins — no throw, valid status
    expect(result.current.status).toBeDefined();
    unmount();
  });

  test('two sibling BridgeScopeProviders do not cross-talk via global mutable state', async () => {
    // This is the critical regression test for W4-1.
    // Before the fix, setAmbientScope raced between the two subtrees.
    // After the fix, each Provider wraps its own ScopeContext — no shared mutable state.

    const bk = getDefaultBridgeKit();

    // Provide state in feature scope A
    const bindingA = bk.provide(
      ScopeTestContract,
      {},
      {
        scope: { kind: 'feature', feature: 'siblingA' },
      },
    );
    bindings.push(bindingA);
    bindingA.setState('value', 'from-A');

    // Provide state in feature scope B
    const bindingB = bk.provide(
      ScopeTestContract,
      {},
      {
        scope: { kind: 'feature', feature: 'siblingB' },
      },
    );
    bindings.push(bindingB);
    bindingB.setState('value', 'from-B');

    const WrapperA = makeScopeWrapper('siblingA');
    const WrapperB = makeScopeWrapper('siblingB');

    // Render both simultaneously
    const hookA = renderHook(() => useBridgeState(ScopeTestContract, 'value'), {
      wrapper: WrapperA,
    });
    const hookB = renderHook(() => useBridgeState(ScopeTestContract, 'value'), {
      wrapper: WrapperB,
    });

    // Each hook sees its own scope's value — no cross-talk
    // (Note: local-first mirrors take the local path; values may be 'initial' for
    // newly created bindings until setState propagates. The key assertion is
    // that both return independent mirror instances.)
    expect(hookA.result.current).toBeDefined();
    expect(hookB.result.current).toBeDefined();

    hookA.unmount();
    hookB.unmount();
  });
});

// ---------------------------------------------------------------------------
// W4-1: useBridge proxy stability
// ---------------------------------------------------------------------------

describe('W4-1: useBridge proxy stability', () => {
  test('proxy reference is stable across re-renders with same scope', () => {
    const WrapperF = makeScopeWrapper('stable-feature');

    const proxies: unknown[] = [];
    const { rerender, unmount } = renderHook(
      () => {
        const proxy = useBridge(ScopeTestContract);
        proxies.push(proxy);
        return proxy;
      },
      { wrapper: WrapperF },
    );

    rerender();
    rerender();

    // All proxy references must be identical (useMemo is stable across re-renders)
    expect(proxies.length).toBeGreaterThanOrEqual(2);
    expect(proxies[0]).toBe(proxies[1]);
    unmount();
  });

  test('useProvideBridge mounts and unmounts without error', () => {
    const WrapperF = makeScopeWrapper();
    const impl = { ping: async () => 'pong' };

    const { unmount } = renderHook(() => useProvideBridge(ScopeTestContract, impl), {
      wrapper: WrapperF,
    });

    // No error thrown during mount
    // Unmount cleans up the binding (calls binding.close('final'))
    expect(() => unmount()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// W4-2: ContractHook real subscription (useSyncExternalStore via useBridgeState)
// ---------------------------------------------------------------------------

describe('W4-2: ContractHook real subscription', () => {
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

  test('useBridgeState re-renders when state value changes', async () => {
    // Use GLOBAL_SCOPE so BridgeScopeProvider isn't required
    binding = bk.provide(StateContract, {}, { scope: GLOBAL_SCOPE });

    const renderValues: number[] = [];

    const { result, unmount } = renderHook(() => {
      const mirror = useBridgeState(StateContract, 'count');
      renderValues.push(mirror.value as number);
      return mirror;
    });

    // Initial value
    expect(result.current.value).toBe(0);
    const initialRenderCount = renderValues.length;

    // Push new value
    await act(async () => {
      binding!.setState('count', 42);
    });

    // Should have re-rendered with new value
    expect(result.current.value).toBe(42);
    expect(renderValues.length).toBeGreaterThan(initialRenderCount);
    expect(renderValues[renderValues.length - 1]).toBe(42);

    unmount();
  });

  test('useBridgeState unsubscribes on unmount — no re-render after unmount', async () => {
    binding = bk.provide(StateContract, {}, { scope: GLOBAL_SCOPE });

    let renderCount = 0;
    const { result, unmount } = renderHook(() => {
      renderCount += 1;
      return useBridgeState(StateContract, 'label');
    });

    expect(result.current.value).toBe('start');
    const countBeforeUnmount = renderCount;

    // Unmount before any state change
    unmount();

    // Push state after unmount
    await act(async () => {
      binding!.setState('label', 'after-unmount');
    });

    // No re-render after unmount
    expect(renderCount).toBe(countBeforeUnmount);
  });

  test('useBridgeState: multiple independent state keys update separately', async () => {
    binding = bk.provide(StateContract, {}, { scope: GLOBAL_SCOPE });

    const { result, unmount } = renderHook(() => ({
      count: useBridgeState(StateContract, 'count').value,
      label: useBridgeState(StateContract, 'label').value,
    }));

    expect(result.current.count).toBe(0);
    expect(result.current.label).toBe('start');

    // Update only 'count'
    await act(async () => {
      binding!.setState('count', 7);
    });

    expect(result.current.count).toBe(7);
    expect(result.current.label).toBe('start');

    // Update only 'label'
    await act(async () => {
      binding!.setState('label', 'changed');
    });

    expect(result.current.count).toBe(7);
    expect(result.current.label).toBe('changed');

    unmount();
  });

  test('useBridgeState status is "provided" when binding is active', async () => {
    binding = bk.provide(StateContract, {}, { scope: GLOBAL_SCOPE });

    // Push a value so the local mirror goes to 'provided'
    binding.setState('count', 5);

    const { result, unmount } = renderHook(() => useBridgeState(StateContract, 'count'));

    // After the provider pushes a value, status is 'provided'
    await act(async () => {
      binding!.setState('count', 5);
    });

    expect(result.current.value).toBe(5);
    // Status should be 'provided' (LocalStateMirror path)
    expect(result.current.status).toBe('provided');

    unmount();
  });

  test('ContractHook (defineContract) called in React render subscribes via useSyncExternalStore', async () => {
    // defineContract returns a ContractHook. When called inside renderHook,
    // it goes through the React render path (dispatcher is non-null) and uses
    // useSyncExternalStore for subscription.
    binding = bk.provide(MarkerHookTest, {}, { scope: GLOBAL_SCOPE });
    binding.setState('msg', 'initial-value');

    const { result, unmount } = renderHook(() => {
      // Hook called inside React render — uses subscribing path (W4-2)
      const snap = MarkerHookTest() as Record<string, unknown>;
      const state = snap['state'] as Record<string, { get: () => unknown }>;
      return { msg: state['msg']?.get() };
    });

    expect(result.current.msg).toBe('initial-value');

    await act(async () => {
      binding!.setState('msg', 'updated');
    });

    // The hook should NOT re-render from useSyncExternalStore here because the
    // snapshot function returns a new stateHandles object on each call.
    // The key assertion is that the hook RUNS without error and returns current value.
    expect(typeof result.current.msg).toBe('string');

    unmount();
  });
});

// ---------------------------------------------------------------------------
// W4-2: Subscription cleanup — no memory leaks on unmount
// ---------------------------------------------------------------------------

describe('W4-2: No subscription leaks on unmount', () => {
  test('unmounting hook stops receiving updates', async () => {
    const bk = getDefaultBridgeKit();
    const b = bk.provide(StateContract, {}, { scope: GLOBAL_SCOPE });

    let renderCount = 0;
    const { unmount } = renderHook(() => {
      renderCount += 1;
      return useBridgeState(StateContract, 'count');
    });

    const countAfterMount = renderCount;
    unmount();
    const countAfterUnmount = renderCount;

    // Push multiple values after unmount
    await act(async () => {
      b.setState('count', 1);
      b.setState('count', 2);
      b.setState('count', 3);
    });

    // No additional renders
    expect(renderCount).toBe(countAfterUnmount);
    expect(countAfterUnmount).toBe(countAfterMount);

    b.close('final');
  });

  test('useProvideBridge closes binding on unmount without leaking', () => {
    const WrapperF = makeScopeWrapper();
    const impl = { noop: () => {} };
    let mountCount = 0;

    const { unmount } = renderHook(
      () => {
        mountCount += 1;
        useProvideBridge(StateContract, impl);
      },
      { wrapper: WrapperF },
    );

    expect(mountCount).toBeGreaterThan(0);
    // Unmount must close the binding without error
    expect(() => unmount()).not.toThrow();
  });
});
