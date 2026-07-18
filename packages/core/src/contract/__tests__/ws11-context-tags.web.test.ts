import { describe, expect, test } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { BridgeKitProvider, BridgeScopeProvider } from '../../react/hooks';
import type { Binding } from '../../runtime/registry';
import { GLOBAL_SCOPE } from '../../runtime/registry';
import { createTestBridge } from '../../testing';
import { decode, encode } from '../codec';
import { defineContract, t } from '../contract';

const ContextContract = defineContract('ws11.context.contract', {
  state: {
    value: t.state(t.string(), 'initial'),
  },
});

function makeBridgeWrapper(bridgeKit: ReturnType<typeof createTestBridge>['bridgekit']) {
  return function BridgeWrapper({ children }: { children: React.ReactNode }) {
    return createElement(BridgeKitProvider, { bridgeKit }, children);
  };
}

function makeFeatureWrapper(bridgeKit: ReturnType<typeof createTestBridge>['bridgekit']) {
  return function FeatureWrapper({ children }: { children: React.ReactNode }) {
    return createElement(
      BridgeKitProvider,
      { bridgeKit },
      createElement(BridgeScopeProvider, { feature: 'catalog' }, children),
    );
  };
}

describe('WS-11 contract hook context and readiness', () => {
  test('hook() consumes the BridgeKit instance supplied by BridgeKitProvider', () => {
    const { bridgekit } = createTestBridge();
    const binding = bridgekit.provide(ContextContract, {}, { scope: GLOBAL_SCOPE });
    binding.setState('value', 'context-instance');

    const { result, unmount } = renderHook(() => ContextContract().state.value.get(), {
      wrapper: makeBridgeWrapper(bridgekit),
    });

    expect(result.current).toBe('context-instance');

    unmount();
    binding.close('final');
  });

  test('hook() retargets its state mirror when a nearer provider becomes ready', () => {
    const { bridgekit } = createTestBridge();
    const globalBinding = bridgekit.provide(ContextContract, {}, { scope: GLOBAL_SCOPE });
    globalBinding.setState('value', 'global-value');
    let featureBinding: Binding | null = null;

    const { result, unmount } = renderHook(() => ContextContract().state.value.get(), {
      wrapper: makeFeatureWrapper(bridgekit),
    });

    expect(result.current).toBe('global-value');

    act(() => {
      featureBinding = bridgekit.provide(
        ContextContract,
        {},
        {
          scope: { kind: 'feature', feature: 'catalog' },
        },
      );
      featureBinding.setState('value', 'feature-value');
    });

    expect(result.current).toBe('feature-value');

    unmount();
    featureBinding?.close('final');
    globalBinding.close('final');
  });
});

describe('WS-11 oneOf schema-authored tags', () => {
  const schema = {
    ...t.oneOf([t.string(), t.number()] as const),
    tags: ['declared-string', 'declared-number'],
  } as const;

  test('encode emits the declared tag for each matching option', () => {
    expect(encode(schema, 'value')).toEqual({ '@t': 'declared-string', '@v': 'value' });
    expect(encode(schema, 42)).toEqual({ '@t': 'declared-number', '@v': 42 });
  });

  test('decode selects options using the declared tags', () => {
    expect(decode(schema, { '@t': 'declared-string', '@v': 'value' })).toBe('value');
    expect(decode(schema, { '@t': 'declared-number', '@v': 42 })).toBe(42);
  });
});
