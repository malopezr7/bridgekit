// ---------------------------------------------------------------------------
// QW-6: native getDefaultBridgeKit platform support
// Ensures the native singleton constructs the Nitro transport on both iOS and
// Android. Metro resolves this file only for React Native bundles.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, jest, test } from '@jest/globals';

// NitroBridgeTransport stub — prevents pulling in native JSI modules.
jest.mock('../runtime/nitroTransport', () => ({
  NitroBridgeTransport: jest.fn().mockImplementation(() => ({
    connect: () => ({ epoch: 1, snapshot: [] }),
    invoke: () => Promise.resolve({ ok: true, value: undefined }),
    invokeSync: () => ({ ok: true, value: undefined }),
    openStream: () => 'stream-id',
    closeStream: () => {},
    emitFromJs: () => {},
    endFromJs: () => {},
    stateRead: () => ({ ok: true, value: undefined }),
    stateObserve: () => 'obs-id',
    stateUnobserve: () => {},
    stateWrite: () => ({ ok: true, value: undefined }),
    pushProviderState: () => {},
    announceProvided: () => {},
    announceUnprovided: () => {},
  })),
}));

// react-native stub with a mutable OS property.
const mockPlatform = { OS: 'android' };
jest.mock('react-native', () => ({
  Platform: mockPlatform,
}));

describe('QW-6: getDefaultBridgeKit native platform support', () => {
  beforeEach(() => {
    // Reset modules so the _default singleton is cleared between tests.
    jest.resetModules();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('com.bridgekit.registry')];
  });

  test('does not throw when Platform.OS is ios', () => {
    mockPlatform.OS = 'ios';

    let getDefaultBridgeKit = (): unknown => {
      throw new Error('runtime module was not loaded');
    };
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ({ getDefaultBridgeKit } = require('../runtime/defaultInstance.native'));
    });

    expect(() => getDefaultBridgeKit()).not.toThrow();
  });

  test('does not throw when Platform.OS is android', () => {
    mockPlatform.OS = 'android';

    let getDefaultBridgeKit = (): unknown => {
      throw new Error('runtime module was not loaded');
    };
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ({ getDefaultBridgeKit } = require('../runtime/defaultInstance.native'));
    });

    expect(() => getDefaultBridgeKit()).not.toThrow();
  });

  test('native entrypoint re-exports the runtime singleton accessor', () => {
    let entrypointGetDefault = (): unknown => {
      throw new Error('native entrypoint was not loaded');
    };
    let runtimeGetDefault = (): unknown => {
      throw new Error('native runtime singleton was not loaded');
    };
    jest.isolateModules(() => {
      ({ getDefaultBridgeKit: entrypointGetDefault } = require('../index.native'));
      ({ getDefaultBridgeKit: runtimeGetDefault } = require('../runtime/defaultInstance.native'));
    });

    expect(entrypointGetDefault).toBe(runtimeGetDefault);
  });

  test('initBridgeKitNative and runtime consumers share one initialized instance', () => {
    let initBridgeKitNative = (): unknown => {
      throw new Error('native entrypoint was not loaded');
    };
    let runtimeGetDefault = (): unknown => {
      throw new Error('native runtime singleton was not loaded');
    };
    jest.isolateModules(() => {
      ({ initBridgeKitNative } = require('../index.native'));
      ({ getDefaultBridgeKit: runtimeGetDefault } = require('../runtime/defaultInstance.native'));
    });

    const initialized = initBridgeKitNative();
    expect(runtimeGetDefault()).toBe(initialized);
  });
});
