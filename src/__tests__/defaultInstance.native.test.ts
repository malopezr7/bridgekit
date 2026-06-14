// ---------------------------------------------------------------------------
// QW-6: iOS guard in getDefaultBridgeKit
// Ensures the function throws a legible error on iOS instead of constructing
// a dead NitroBridgeTransport.
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

describe('QW-6: getDefaultBridgeKit iOS guard', () => {
  beforeEach(() => {
    // Reset modules so the _default singleton is cleared between tests.
    jest.resetModules();
  });

  test('throws a legible error when Platform.OS is ios', () => {
    mockPlatform.OS = 'ios';

    let getDefaultBridgeKit: () => unknown;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ({ getDefaultBridgeKit } = require('../runtime/defaultInstance.native'));
    });

    // @ts-ignore — assigned synchronously inside isolateModules
    expect(() => getDefaultBridgeKit()).toThrow(/iOS/i);
    // @ts-ignore
    expect(() => getDefaultBridgeKit()).toThrow(/not yet implemented|not implemented/i);
  });

  test('does not throw when Platform.OS is android', () => {
    mockPlatform.OS = 'android';

    let getDefaultBridgeKit: () => unknown;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ({ getDefaultBridgeKit } = require('../runtime/defaultInstance.native'));
    });

    // @ts-ignore — assigned synchronously inside isolateModules
    expect(() => getDefaultBridgeKit()).not.toThrow();
  });
});
