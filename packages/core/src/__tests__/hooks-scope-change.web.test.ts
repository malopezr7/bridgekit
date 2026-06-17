// Regression: useBridgeReady must re-evaluate when scope prop changes (H-12).
// Initial readiness must reflect the CURRENT scope, not the mount-time scope.
import { afterEach, describe, expect, test } from '@jest/globals';
import { render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { defineContract, t } from '../contract/contract';
import { Async } from '../contract/markers';
import type { BridgeScope } from '../contract/protocol';
import { BridgeScopeProvider, useBridgeReady } from '../react/hooks';
import { getDefaultBridgeKit } from '../runtime/defaultInstance';
import type { Binding } from '../runtime/registry';

const C = defineContract('hooks.scope.change.test', {
  methods: { ping: Async(t.string()) },
});

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

describe('regression: useBridgeReady re-evaluates on scope change', () => {
  test('PATH A: opts.scope prop alpha->beta — re-reports readiness for new scope', () => {
    const b = getDefaultBridgeKit().provide(
      C,
      { ping: async () => 'pong' },
      { scope: { kind: 'feature', feature: 'beta' } },
    );
    bindings.push(b);

    const { result, rerender } = renderHook(
      ({ feature }: { feature: string }) =>
        useBridgeReady(C, { scope: { kind: 'feature', feature } as BridgeScope }),
      { initialProps: { feature: 'alpha' } },
    );

    expect(result.current).toBe(false); // alpha has no provider
    rerender({ feature: 'beta' });
    // beta HAS a provider — hook must reflect new scope
    expect(result.current).toBe(true);
  });

  test('PATH C (inverse): provided->unprovided scope — no stale true', () => {
    const b = getDefaultBridgeKit().provide(
      C,
      { ping: async () => 'pong' },
      { scope: { kind: 'feature', feature: 'has' } },
    );
    bindings.push(b);

    const { result, rerender } = renderHook(
      ({ feature }: { feature: string }) =>
        useBridgeReady(C, { scope: { kind: 'feature', feature } as BridgeScope }),
      { initialProps: { feature: 'has' } },
    );

    expect(result.current).toBe(true); // 'has' is provided
    rerender({ feature: 'missing' });
    // 'missing' has no provider — must not stay true (stale)
    expect(result.current).toBe(false);
  });

  test('PATH B: ancestor BridgeScopeProvider switches feature alpha2->beta2', () => {
    const b = getDefaultBridgeKit().provide(
      C,
      { ping: async () => 'pong' },
      { scope: { kind: 'feature', feature: 'beta2' } },
    );
    bindings.push(b);

    function Child({ onReady }: { onReady: (v: boolean) => void }) {
      const ready = useBridgeReady(C);
      onReady(ready);
      return null;
    }

    let last = false;
    const tree = (feature: string) =>
      createElement(
        BridgeScopeProvider,
        { feature },
        createElement(Child, { onReady: (v: boolean) => (last = v) }),
      );

    const { rerender } = render(tree('alpha2'));
    expect(last).toBe(false); // alpha2 has no provider
    rerender(tree('beta2'));
    // ancestor scope is now beta2, which HAS a binding
    expect(last).toBe(true);
  });
});
