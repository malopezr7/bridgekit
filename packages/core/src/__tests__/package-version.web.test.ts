import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

describe('package version invariant', () => {
  test('duplicate-package diagnostic reports this package version', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      version: string;
    };
    const registrySymbol = Symbol.for('com.bridgekit.registry');
    const globalRegistry = globalThis as Record<symbol, unknown>;
    const previousRegistry = globalRegistry[registrySymbol];
    const existingInstance = {};

    globalRegistry[registrySymbol] = {
      instance: existingInstance,
      version: '0.0.1-beta.1',
    };

    try {
      let getDefaultBridgeKit = (): unknown => {
        throw new Error('default instance module was not loaded');
      };
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        ({ getDefaultBridgeKit } = require('../runtime/defaultInstance'));
      });

      expect(() => getDefaultBridgeKit()).toThrow(
        `Already loaded version: 0.0.1-beta.1, this copy: ${packageJson.version}.`,
      );
    } finally {
      jest.resetModules();
      if (previousRegistry === undefined) {
        delete globalRegistry[registrySymbol];
      } else {
        globalRegistry[registrySymbol] = previousRegistry;
      }
    }
  });

  test.each([
    'src/index.native.ts',
    'src/runtime/defaultInstance.ts',
    'src/runtime/defaultInstance.native.ts',
  ])('%s matches packages/core/package.json', (relativePath) => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      version: string;
    };
    const source = readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    const packageVersion = source.match(/const PACKAGE_VERSION = '([^']+)'/);

    expect(packageVersion?.[1]).toBe(packageJson.version);
  });
});
