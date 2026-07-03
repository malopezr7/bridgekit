import { afterEach, describe, expect, test } from '@jest/globals';
import { isBridgeKitDev } from '../env';

const originalDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const originalProcess = globalThis.process;

function setDev(value: boolean | undefined) {
  if (typeof value === 'boolean') {
    Object.defineProperty(globalThis, '__DEV__', {
      configurable: true,
      value,
      writable: true,
    });
    return;
  }

  Reflect.deleteProperty(globalThis, '__DEV__');
}

function setNodeEnv(value: string | undefined) {
  Object.defineProperty(globalThis, 'process', {
    configurable: true,
    value: typeof value === 'string' ? { env: { NODE_ENV: value } } : undefined,
    writable: true,
  });
}

function setProcessEnvWithoutNodeEnv() {
  Object.defineProperty(globalThis, 'process', {
    configurable: true,
    value: { env: {} },
    writable: true,
  });
}

describe('isBridgeKitDev', () => {
  afterEach(() => {
    setDev(originalDev);
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: originalProcess,
      writable: true,
    });
  });

  test('honors React Native __DEV__ when true', () => {
    setDev(true);
    setNodeEnv('production');

    expect(isBridgeKitDev()).toBe(true);
  });

  test('honors React Native __DEV__ when false', () => {
    setDev(false);
    setNodeEnv('development');

    expect(isBridgeKitDev()).toBe(false);
  });

  test.each([
    ['production', false],
    ['development', true],
    ['test', true],
  ])('maps NODE_ENV=%s to %s when __DEV__ is absent', (nodeEnv, expected) => {
    setDev(undefined);
    setNodeEnv(nodeEnv);

    expect(isBridgeKitDev()).toBe(expected);
  });

  test('assumes production when neither __DEV__ nor process are available', () => {
    setDev(undefined);
    Reflect.deleteProperty(globalThis, 'process');

    expect(isBridgeKitDev()).toBe(false);
  });

  test('assumes production when process.env exists without NODE_ENV', () => {
    setDev(undefined);
    setProcessEnvWithoutNodeEnv();

    expect(isBridgeKitDev()).toBe(false);
  });
});
