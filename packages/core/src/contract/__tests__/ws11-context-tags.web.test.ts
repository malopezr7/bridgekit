import { describe, expect, test } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { BridgeKitProvider, BridgeScopeProvider } from '../../react/hooks';
import type { Binding } from '../../runtime/registry';
import { GLOBAL_SCOPE } from '../../runtime/registry';
import { createTestBridge } from '../../testing';
import { decode, encode } from '../codec';
import { defineContract, t } from '../contract';
import { stableSchemaHash } from '../hash';
import type { OneOfSchema } from '../schema';

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

  test('hook.useProvide registers with the BridgeKit instance supplied by BridgeKitProvider', () => {
    const { bridgekit } = createTestBridge();
    const { unmount } = renderHook(() => ContextContract.useProvide({}), {
      wrapper: makeBridgeWrapper(bridgekit),
    });

    expect(bridgekit.isProvided(ContextContract, { scope: GLOBAL_SCOPE })).toBe(true);

    unmount();
    expect(bridgekit.isProvided(ContextContract, { scope: GLOBAL_SCOPE })).toBe(false);
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

  test('unrelated-scope readiness does not churn the hook snapshot on parent rerender', () => {
    const { bridgekit } = createTestBridge();
    const { result, rerender, unmount } = renderHook(() => ContextContract(), {
      wrapper: makeFeatureWrapper(bridgekit),
    });
    const initialSnapshot = result.current;
    let unrelatedBinding: Binding | null = null;

    act(() => {
      unrelatedBinding = bridgekit.provide(ContextContract, {}, {
        scope: { kind: 'feature', feature: 'unrelated' },
      });
    });
    rerender();

    expect(result.current).toBe(initialSnapshot);

    unmount();
    unrelatedBinding?.close('final');
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

  test('declared tag divergence changes schema and contract hashes', () => {
    const leftTags = {
      ...t.oneOf([t.string(), t.number()] as const),
      tags: ['left-string', 'left-number'],
    } as const;
    const rightTags = {
      ...t.oneOf([t.string(), t.number()] as const),
      tags: ['right-string', 'right-number'],
    } as const;

    const leftContract = defineContract('ws11.tags.hash', {
      methods: { choose: t.query(leftTags, t.string()) },
    });
    const rightContract = defineContract('ws11.tags.hash', {
      methods: { choose: t.query(rightTags, t.string()) },
    });

    expect(stableSchemaHash(leftTags)).not.toBe(stableSchemaHash(rightTags));
    expect(leftContract.hash).not.toBe(rightContract.hash);
  });

  test('non-ASCII declared tags use locale-independent code-unit order', () => {
    const nonAsciiTags = {
      ...t.oneOf([t.string(), t.number()] as const),
      tags: ['ä-tag', 'z-tag'],
    } as const;

    expect(stableSchemaHash(nonAsciiTags)).toBe('7553b24a');
  });

  test.each([
    ['one tag per option', ['only-one']],
    ['non-empty strings', ['valid', '']],
    ['non-empty strings', ['valid', 42]],
    ['unique', ['same', 'same']],
  ])('defineContract rejects declared tags that are not %s', (message, tags) => {
    const invalidSchema = {
      ...t.oneOf([t.string(), t.number()] as const),
      tags,
    } as unknown as OneOfSchema;

    expect(() =>
      defineContract('ws11.tags.invalid', {
        methods: { choose: t.query(invalidSchema, t.string()) },
      }),
    ).toThrow(message);
  });
});
