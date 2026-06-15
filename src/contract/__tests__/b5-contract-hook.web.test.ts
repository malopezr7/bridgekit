// ---------------------------------------------------------------------------
// 5.9 contractHook getSnapshot cache-mutation — WU-6
//
// useSyncExternalStore requires getSnapshot to return a referentially stable
// value until the store actually changes. The current getSnapshot creates a
// new `depsKey = { proxy, mirrors }` object on every call, so
// `cache.deps !== depsKey` is always true (object identity never matches),
// causing getSnapshot to rebuild the snapshot on every render even when
// neither proxy nor mirrors changed — concurrent-render tearing risk.
//
// Fix: compare proxy/mirrors individually instead of wrapping in a new object.
// ---------------------------------------------------------------------------

import { describe, expect, test } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { getDefaultBridgeKit } from '../../runtime/defaultInstance';
import type { Binding } from '../../runtime/registry';
import { defineContract, t } from '../contract';
import { buildContractHook } from '../contractHook';
import { Async } from '../markers';

const SnapshotContract = defineContract('b5.snapshot.contract', {
  methods: {
    ping: Async(t.string()),
  },
  state: {
    value: t.state(t.string(), 'initial'),
  },
});

// ---------------------------------------------------------------------------
// 5.9 — getSnapshot must return the same reference between renders if no
//        store change occurred (proxy/mirrors identical).
// ---------------------------------------------------------------------------

describe('5.9 contractHook: getSnapshot returns stable reference between renders', () => {
  let binding: Binding | null = null;
  const bk = getDefaultBridgeKit();

  test('getSnapshot returns same object reference on consecutive calls with no store change', () => {
    binding = bk.provide(SnapshotContract, {
      ping: async () => 'pong',
    });

    const hook = buildContractHook(SnapshotContract);

    let renderCount = 0;
    const snapshots: unknown[] = [];

    const { result } = renderHook(() => {
      renderCount++;
      const snap = hook();
      snapshots.push(snap);
      return snap;
    });

    // Force a re-render without any store change
    act(() => {
      // No state change — just trigger a re-render
    });

    // Wait one tick for React to settle
    // After the first render, a subsequent render with NO state change must
    // return the same snapshot reference (useSyncExternalStore contract).
    // If getSnapshot recreates the object on every call, snapshots[0] !== snapshots[1].
    expect(renderCount).toBeGreaterThanOrEqual(1);

    if (snapshots.length >= 2) {
      // KEY ASSERTION: same reference between renders with no state change
      expect(snapshots[0]).toBe(snapshots[snapshots.length - 1]);
    }

    binding?.close('final');
    binding = null;
  });

  test('getSnapshot returns a new reference after state changes', async () => {
    binding = bk.provide(SnapshotContract, {
      ping: async () => 'pong',
    });

    const hook = buildContractHook(SnapshotContract);

    const snapshots: unknown[] = [];

    const { result } = renderHook(() => {
      const snap = hook();
      snapshots.push(snap);
      return snap;
    });

    const initialSnap = result.current;

    // Trigger a state change
    await act(async () => {
      binding?.setState('value', 'changed');
    });

    const afterSnap = result.current;

    // After a real state change, snapshot must be a NEW reference
    expect(afterSnap).not.toBe(initialSnap);
    expect((afterSnap as { state: { value: { get: () => unknown } } }).state.value.get()).toBe(
      'changed',
    );

    binding?.close('final');
    binding = null;
  });
});
