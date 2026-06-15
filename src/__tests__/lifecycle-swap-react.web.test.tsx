// Regression: React component swap (A unmounts after B mounted) must NOT clobber live provider.
// C-3 + H-10: stale A.close after B supersedes must leave B's state intact.
import { afterEach, describe, expect, test } from '@jest/globals';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, useState } from 'react';
import { defineContract, t } from '../contract/contract';
import { State } from '../contract/markers';
import { useBridgeState, useProvideBridge } from '../react/hooks';
import { getDefaultBridgeKit } from '../runtime/defaultInstance';
import { GLOBAL_SCOPE } from '../runtime/registry';

afterEach(() => cleanup());

const C = defineContract('react.swap.lifecycle.test', {
  state: { count: State(t.number(), 0) },
});

function ProviderA() {
  useProvideBridge(C, {});
  return null;
}

function ProviderB() {
  useProvideBridge(C, {});
  return null;
}

describe('regression: React swap — A unmounts after B supersedes, B state intact', () => {
  test('B remains live and retains state after stale A unmount-close', () => {
    const bk = getDefaultBridgeKit();

    function Tree({ showA }: { showA: boolean }) {
      return createElement(
        'div',
        null,
        showA ? createElement(ProviderA, { key: 'a' }) : null,
        createElement(ProviderB, { key: 'b' }),
      );
    }

    let rerender: (ui: React.ReactElement) => void = () => {};
    act(() => {
      const r = render(createElement(Tree, { showA: true }));
      rerender = r.rerender;
    });

    // B is the live provider (mounted second, superseded A)
    const liveB = bk.registry.resolve(C.descriptor.id, GLOBAL_SCOPE);
    expect(liveB?.binding.isLive).toBe(true);
    act(() => {
      liveB!.binding.setState('count', 99);
    });
    expect(bk.registry.getState(C.descriptor.id, GLOBAL_SCOPE, 'count')).toBe(99);

    // Unmount A only — A's cleanup fires binding.close('final') but A is already superseded
    act(() => {
      rerender(createElement(Tree, { showA: false }));
    });

    const stillLive = bk.registry.resolve(C.descriptor.id, GLOBAL_SCOPE);
    // B must still be live and hold 99 after A's stale unmount-close
    expect(stillLive?.binding.isLive).toBe(true);
    expect(bk.registry.getState(C.descriptor.id, GLOBAL_SCOPE, 'count')).toBe(99);
  });
});
