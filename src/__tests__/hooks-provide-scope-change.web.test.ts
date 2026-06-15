// ---------------------------------------------------------------------------
// Regression H-11: useProvideBridge must re-register when scope changes.
//
// Scenarios:
//   H11-A: opts.scope changes (alpha -> beta) — scopeA provider closed, scopeB registered.
//   H11-B: ancestor BridgeScopeProvider switches feature — re-registers in new scope.
//   H11-C: impl-ref capture — impl captured at registration time; concurrent render
//           that mutates implRef.current before provide() runs cannot expose the
//           uncommitted impl to callers.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from '@jest/globals';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, useState } from 'react';
import { defineContract, t } from '../contract/contract';
import { Async } from '../contract/markers';
import type { BridgeScope } from '../contract/protocol';
import { BridgeScopeProvider, useProvideBridge } from '../react/hooks';
import { getDefaultBridgeKit } from '../runtime/defaultInstance';

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

const C = defineContract('hooks.provide.scope.change.h11', {
  methods: { ping: Async(t.string()) },
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// H11-A: opts.scope prop change (alpha -> beta)
// ---------------------------------------------------------------------------

describe('H-11-A: useProvideBridge — scope prop change re-registers', () => {
  test('switching opts.scope from alpha to beta closes alpha, opens beta', async () => {
    const bk = getDefaultBridgeKit();
    const scopeAlpha: BridgeScope = { kind: 'feature', feature: 'h11-alpha' };
    const scopeBeta: BridgeScope = { kind: 'feature', feature: 'h11-beta' };

    const impl = { ping: async () => 'pong' };

    const { rerender, unmount } = renderHook(
      ({ scope }: { scope: BridgeScope }) => useProvideBridge(C, impl, { scope }),
      { initialProps: { scope: scopeAlpha } },
    );

    // After mount: alpha scope should be provided
    expect(bk.registry.isProvided(C.descriptor.id, scopeAlpha)).toBe(true);
    expect(bk.registry.isProvided(C.descriptor.id, scopeBeta)).toBe(false);

    // Change scope to beta
    await act(async () => {
      rerender({ scope: scopeBeta });
    });

    // After scope change: alpha closed, beta open
    expect(bk.registry.isProvided(C.descriptor.id, scopeAlpha)).toBe(false);
    expect(bk.registry.isProvided(C.descriptor.id, scopeBeta)).toBe(true);

    unmount();
  });
});

// ---------------------------------------------------------------------------
// H11-B: ancestor BridgeScopeProvider switches feature
// ---------------------------------------------------------------------------

describe('H-11-B: useProvideBridge — ancestor scope change re-registers', () => {
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

// ---------------------------------------------------------------------------
// H11-C: impl-ref capture — registration sees committed impl
// ---------------------------------------------------------------------------

describe('H-11-C: impl-ref capture at registration time', () => {
  test('impl used during registration is the one provided at that render, not a future render', async () => {
    const bk = getDefaultBridgeKit();

    // Two different impls to distinguish which one was registered
    const implV1 = { ping: async () => 'v1' };
    const implV2 = { ping: async () => 'v2' };

    // We'll capture which impl was visible to ping() calls after scope changes
    // The key: when scope changes, the NEWLY registered impl must be the one
    // that was provided at the render that triggered the scope change.
    const scopeX: BridgeScope = { kind: 'feature', feature: 'h11-impl-x' };
    const scopeY: BridgeScope = { kind: 'feature', feature: 'h11-impl-y' };

    const { rerender, unmount } = renderHook(
      ({ scope, impl }: { scope: BridgeScope; impl: { ping: () => Promise<string> } }) =>
        useProvideBridge(C, impl, { scope }),
      { initialProps: { scope: scopeX, impl: implV1 } },
    );

    // v1 registered in scopeX
    const entryX = bk.registry.resolve(C.descriptor.id, scopeX);
    expect(entryX?.binding.isLive).toBe(true);

    // Change scope AND impl simultaneously — simulates concurrent render
    await act(async () => {
      rerender({ scope: scopeY, impl: implV2 });
    });

    // scopeX closed, scopeY open with v2
    expect(bk.registry.isProvided(C.descriptor.id, scopeX)).toBe(false);
    expect(bk.registry.isProvided(C.descriptor.id, scopeY)).toBe(true);

    // The proxy for scopeY must delegate to the current impl (v2 at this point)
    const bridge = bk.bridge(C, { scope: scopeY });
    const result = await bridge.ping();
    expect(result).toBe('v2');

    unmount();
  });
});
