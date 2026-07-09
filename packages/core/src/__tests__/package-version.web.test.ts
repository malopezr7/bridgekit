import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

describe('package version invariant', () => {
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
