import { describe, expect, test } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { defineContract, t } from '../../contract/contract';
import type { CallEnvelope, ResultEnvelope } from '../../contract/protocol';
import { BridgeKitProvider, useBridgeState } from '../../react/hooks';
import { BridgeKitJs } from '../bridgekit';
import { GLOBAL_SCOPE } from '../registry';
import type { BridgeTransport, ConnectResult, JsDispatcher } from '../transport';

const MirrorContract = defineContract('state.mirror.reeval.test', {
  state: {
    count: { kind: 'state', value: t.number(), initial: 0 },
  },
});

class MirrorTransport implements BridgeTransport {
  stateObserveCalls = 0;
  nativeValue = 99;

  connect(_dispatcher: JsDispatcher): ConnectResult {
    return { epoch: 1, snapshot: [], nativeProvided: [] };
  }
  invoke(): Promise<ResultEnvelope> {
    return Promise.resolve({ ok: true, value: undefined });
  }
  invokeSync(): ResultEnvelope {
    return { ok: true, value: undefined };
  }
  openStream(): string {
    return 'stream-id';
  }
  closeStream(): void {}
  emitFromJs(): void {}
  endFromJs(): void {}
  stateRead(): ResultEnvelope {
    return { ok: true, value: this.nativeValue };
  }
  stateObserve(_env: CallEnvelope, onChange: (value: unknown) => void): string {
    this.stateObserveCalls += 1;
    onChange(this.nativeValue);
    return `obs-${this.stateObserveCalls}`;
  }
  stateUnobserve(): void {}
  stateWrite(): ResultEnvelope {
    return { ok: true };
  }
  pushProviderState(): void {}
  announceProvided(): void {}
  announceUnprovided(): void {}
}

function makeWrapper(bk: BridgeKitJs) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(BridgeKitProvider, { bridgeKit: bk }, children);
  };
}

describe('RT-JS-13 mirror re-evaluation on provider changes', () => {
  test('RT-JS-13 local provider appears', () => {
    const transport = new MirrorTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const { result, unmount } = renderHook(
      () => useBridgeState(MirrorContract, 'count', { scope: GLOBAL_SCOPE }),
      { wrapper: makeWrapper(bk) },
    );

    expect(result.current).toEqual({ value: 99, status: 'provided' });
    act(() => {
      const binding = bk.provide(MirrorContract, {}, { scope: GLOBAL_SCOPE });
      binding.setState('count', 42);
    });

    expect(result.current).toEqual({ value: 42, status: 'provided' });
    unmount();
  });

  test('Local provider disappears', () => {
    const transport = new MirrorTransport();
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const binding = bk.provide(MirrorContract, {}, { scope: GLOBAL_SCOPE });
    binding.setState('count', 5);
    const { result, unmount } = renderHook(
      () => useBridgeState(MirrorContract, 'count', { scope: GLOBAL_SCOPE }),
      { wrapper: makeWrapper(bk) },
    );

    expect(result.current).toEqual({ value: 5, status: 'provided' });
    act(() => {
      binding.close('final');
    });

    expect(result.current).toEqual({ value: 99, status: 'provided' });
    unmount();
  });
});
