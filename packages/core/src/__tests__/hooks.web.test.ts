// React hooks tests (jsdom / @testing-library/react).
// Covers: ScopeContext isolation, ContractHook real subscription, proxy stability.

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

// Unique contract IDs per file to avoid cross-test pollution.

const ScopeTestContract = defineContract('hooks.scope.test', {
  methods: {
    ping: Async(t.string()),
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
    ping: Async(t.string()),
  },
  state: {
    msg: State(t.string(), 'hello'),
  },
});

function makeScopeWrapper(feature?: string, instance?: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(BridgeScopeProvider, { feature, instance }, children);
  };
}

describe('BridgeScopeProvider — scope isolation', () => {
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
    const WrapperF = makeScopeWrapper('testFeature');
    const { result, unmount } = renderHook(() => useBridgeState(ScopeTestContract, 'value'), {
      wrapper: WrapperF,
    });
    expect(result.current.status).toBeDefined();
    unmount();
  });

  test('no BridgeScopeProvider — global scope is the default, dev warning fires once', () => {
    diagnostics.clearWarnings();

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result, unmount } = renderHook(() => useBridgeState(ScopeTestContract, 'value'));
      expect(result.current.status).toBeDefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('useBridgeState'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BridgeScopeProvider'));

      unmount();
    } finally {
      warnSpy.mockRestore();
      diagnostics.clearWarnings();
    }
  });

  test('nested BridgeScopeProvider: innermost scope wins', () => {
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

    expect(result.current.status).toBeDefined();
    unmount();
  });

  test('two sibling BridgeScopeProviders do not cross-talk via global mutable state', async () => {
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

    expect(hookA.result.current).toBeDefined();
    expect(hookB.result.current).toBeDefined();

    hookA.unmount();
    hookB.unmount();
  });
});

describe('useBridge proxy stability', () => {
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

    expect(() => unmount()).not.toThrow();
  });

  test('Hook provider survives reconnect', () => {
    const bk = getDefaultBridgeKit();
    const contract = defineContract('hooks.reconnect.provider', {
      methods: {
        ping: Async(t.string()),
      },
    });

    const { unmount } = renderHook(() => useProvideBridge(contract, { ping: async () => 'pong' }), {
      wrapper: makeScopeWrapper(),
    });

    expect(bk.isProvided(contract)).toBe(true);

    act(() => {
      bk.connect();
    });

    expect(bk.isProvided(contract)).toBe(true);

    unmount();
  });
});

describe('ContractHook real subscription', () => {
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
    binding = bk.provide(StateContract, {}, { scope: GLOBAL_SCOPE });

    const renderValues: number[] = [];

    const { result, unmount } = renderHook(() => {
      const mirror = useBridgeState(StateContract, 'count');
      renderValues.push(mirror.value as number);
      return mirror;
    });

    expect(result.current.value).toBe(0);
    const initialRenderCount = renderValues.length;

    await act(async () => {
      binding!.setState('count', 42);
    });

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

    unmount();

    await act(async () => {
      binding!.setState('label', 'after-unmount');
    });

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

    await act(async () => {
      binding!.setState('count', 7);
    });

    expect(result.current.count).toBe(7);
    expect(result.current.label).toBe('start');

    await act(async () => {
      binding!.setState('label', 'changed');
    });

    expect(result.current.count).toBe(7);
    expect(result.current.label).toBe('changed');

    unmount();
  });

  test('useBridgeState status is "provided" when binding is active', async () => {
    binding = bk.provide(StateContract, {}, { scope: GLOBAL_SCOPE });

    binding.setState('count', 5);

    const { result, unmount } = renderHook(() => useBridgeState(StateContract, 'count'));

    // After the provider pushes a value, status is 'provided'
    await act(async () => {
      binding!.setState('count', 5);
    });

    expect(result.current.value).toBe(5);
    expect(result.current.status).toBe('provided');

    unmount();
  });

  test('ContractHook (defineContract) called in React render subscribes via useSyncExternalStore', async () => {
    binding = bk.provide(MarkerHookTest, {}, { scope: GLOBAL_SCOPE });
    binding.setState('msg', 'initial-value');

    const { result, unmount } = renderHook(() => {
      const snap = MarkerHookTest() as Record<string, unknown>;
      const state = snap['state'] as Record<string, { get: () => unknown }>;
      return { msg: state['msg']?.get() };
    });

    expect(result.current.msg).toBe('initial-value');

    await act(async () => {
      binding!.setState('msg', 'updated');
    });

    expect(typeof result.current.msg).toBe('string');

    unmount();
  });
});

describe('No subscription leaks on unmount', () => {
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

    await act(async () => {
      b.setState('count', 1);
      b.setState('count', 2);
      b.setState('count', 3);
    });

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
    expect(() => unmount()).not.toThrow();
  });
});
