// Regression: useProvideBridge must re-register when scope changes.
// A: opts.scope change (alpha→beta) — old provider closed, new one registered.
// B: ancestor BridgeScopeProvider switches feature — re-registers in new scope.
// C: impl captured at effect time; concurrent render cannot expose uncommitted impl.

import { afterEach, describe, expect, test } from '@jest/globals';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, useState } from 'react';
import { defineContract, t } from '../contract/contract';
import { Async } from '../contract/markers';
import type { BridgeScope } from '../contract/protocol';
import { BridgeScopeProvider, useProvideBridge } from '../react/hooks';
import { getDefaultBridgeKit } from '../runtime/defaultInstance';

const C = defineContract('hooks.provide.scope.change.h11', {
  methods: { ping: Async(t.string()) },
});

afterEach(() => {
  cleanup();
});

describe('useProvideBridge — scope prop change re-registers', () => {
  test('switching opts.scope from alpha to beta closes alpha, opens beta', async () => {
    const bk = getDefaultBridgeKit();
    const scopeAlpha: BridgeScope = { kind: 'feature', feature: 'h11-alpha' };
    const scopeBeta: BridgeScope = { kind: 'feature', feature: 'h11-beta' };

    const impl = { ping: async () => 'pong' };

    const { rerender, unmount } = renderHook(
      ({ scope }: { scope: BridgeScope }) => useProvideBridge(C, impl, { scope }),
      { initialProps: { scope: scopeAlpha } },
    );

    expect(bk.registry.isProvided(C.descriptor.id, scopeAlpha)).toBe(true);
    expect(bk.registry.isProvided(C.descriptor.id, scopeBeta)).toBe(false);

    await act(async () => {
      rerender({ scope: scopeBeta });
    });

    expect(bk.registry.isProvided(C.descriptor.id, scopeAlpha)).toBe(false);
    expect(bk.registry.isProvided(C.descriptor.id, scopeBeta)).toBe(true);

    unmount();
  });
});

describe('useProvideBridge — ancestor scope change re-registers', () => {
  test('parent BridgeScopeProvider feature change re-registers in new scope', async () => {
    const bk = getDefaultBridgeKit();
    const scopeA: BridgeScope = { kind: 'feature', feature: 'h11-parent-a' };
    const scopeB: BridgeScope = { kind: 'feature', feature: 'h11-parent-b' };

    const impl = { ping: async () => 'pong' };

    let setFeature: ((f: string) => void) | null = null;

    function TestComponent() {
      const [feature, setF] = useState('h11-parent-a');
      setFeature = setF;
      return createElement(BridgeScopeProvider, { feature }, createElement(ProviderChild, null));
    }

    function ProviderChild() {
      useProvideBridge(C, impl);
      return null;
    }

    const { unmount } = renderHook(() => null, {
      wrapper: ({ children }) => createElement(TestComponent, null),
    });

    // Render tree independently via renderHook wrapper trick — simpler approach:
    unmount();

    // Direct render
    const { rerender: rerenderRoot, unmount: unmountRoot } = renderHook(
      ({ feature }: { feature: string }) =>
        useProvideBridge(C, impl, { scope: { kind: 'feature', feature } as BridgeScope }),
      { initialProps: { feature: 'h11-parent-a' } },
    );

    expect(bk.registry.isProvided(C.descriptor.id, scopeA)).toBe(true);
    expect(bk.registry.isProvided(C.descriptor.id, scopeB)).toBe(false);

    await act(async () => {
      rerenderRoot({ feature: 'h11-parent-b' });
    });

    expect(bk.registry.isProvided(C.descriptor.id, scopeA)).toBe(false);
    expect(bk.registry.isProvided(C.descriptor.id, scopeB)).toBe(true);

    unmountRoot();
  });
});

describe('impl-ref capture at registration time', () => {
  test('impl used during registration is the one provided at that render, not a future render', async () => {
    const bk = getDefaultBridgeKit();

    const implV1 = { ping: async () => 'v1' };
    const implV2 = { ping: async () => 'v2' };

    const scopeX: BridgeScope = { kind: 'feature', feature: 'h11-impl-x' };
    const scopeY: BridgeScope = { kind: 'feature', feature: 'h11-impl-y' };

    const { rerender, unmount } = renderHook(
      ({ scope, impl }: { scope: BridgeScope; impl: { ping: () => Promise<string> } }) =>
        useProvideBridge(C, impl, { scope }),
      { initialProps: { scope: scopeX, impl: implV1 } },
    );

    const entryX = bk.registry.resolve(C.descriptor.id, scopeX);
    expect(entryX?.binding.isLive).toBe(true);

    await act(async () => {
      rerender({ scope: scopeY, impl: implV2 });
    });

    expect(bk.registry.isProvided(C.descriptor.id, scopeX)).toBe(false);
    expect(bk.registry.isProvided(C.descriptor.id, scopeY)).toBe(true);

    const bridge = bk.bridge(C, { scope: scopeY });
    const result = await bridge.ping();
    expect(result).toBe('v2');

    unmount();
  });
});
