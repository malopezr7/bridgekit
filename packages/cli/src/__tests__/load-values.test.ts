import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { decodeLoaderPayload, encodeLoaderPayload, loadContractsFromFile } from '../load.js';

const cliRoot = process.cwd();

describe('contract loader value codec', () => {
  it('round-trips BigInt, Date, Uint8Array, undefined, and JSON-compatible structures', () => {
    const value = {
      bigint: 9_007_199_254_740_993n,
      date: new Date('2024-03-04T05:06:07.890Z'),
      bytes: new Uint8Array([0, 1, 2, 254, 255]),
      nested: [true, null, undefined, { text: 'value', number: 42.5 }],
    };

    const decoded = decodeLoaderPayload(encodeLoaderPayload([value]));

    expect(decoded).toEqual([value]);
    expect((decoded[0] as typeof value).date).toBeInstanceOf(Date);
    expect((decoded[0] as typeof value).bytes).toBeInstanceOf(Uint8Array);
  });

  it.each([
    [
      'cyclic values',
      () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        return cyclic;
      },
      /cycle/i,
    ],
    ['functions', () => ({ unsupported: () => 'nope' }), /function/i],
    ['symbols', () => ({ unsupported: Symbol('nope') }), /symbol/i],
    ['invalid dates', () => ({ invalid: new Date(Number.NaN) }), /invalid date/i],
  ])('rejects unsupported %s before writing fd 3', (_label, makeValue, message) => {
    expect(() => encodeLoaderPayload([makeValue()])).toThrow(message);
  });

  it.each([
    ['reserved envelope versions', { $bridgekitLoader: 'v2', tokens: [] }, /unsupported.*v2/i],
    [
      'unknown node tags',
      { $bridgekitLoader: 'v1', tokens: [{ t: '$bridgekitLoader' }] },
      /unknown.*\$bridgekitLoader/i,
    ],
    [
      'malformed bigint payloads',
      { $bridgekitLoader: 'v1', tokens: [{ t: 'bi', v: '01' }] },
      /bigint/i,
    ],
    [
      'invalid date payloads',
      { $bridgekitLoader: 'v1', tokens: [{ t: 'date', v: Number.NaN }] },
      /date/i,
    ],
    [
      'invalid base64 payloads',
      { $bridgekitLoader: 'v1', tokens: [{ t: 'u8', v: 'not base64!' }] },
      /base64/i,
    ],
  ])('rejects %s with a useful diagnostic', (_label, payload, message) => {
    expect(() => decodeLoaderPayload(JSON.stringify(payload))).toThrow(message);
  });
});

describe('contract loader state initials', () => {
  it('loads bigint, date, and binary state initials losslessly from the fd-3 worker', async () => {
    const parent = path.join(cliRoot, 'build/load-values');
    mkdirSync(parent, { recursive: true });
    const workspace = mkdtempSync(path.join(parent, 'case-'));
    const contractPath = path.join(workspace, 'values.contract.ts');

    try {
      writeFileSync(
        contractPath,
        `import { defineContract, t } from '@malopezr7/bridgekit/contract';

export const LoaderValues = defineContract('loader.values', {
  state: {
    large: t.state(t.int64(), 9007199254740993n),
    updatedAt: t.state(t.date(), new Date('2024-03-04T05:06:07.890Z')),
    payload: t.state(t.binary(), new Uint8Array([0, 1, 2, 254, 255])),
  },
});
`,
        'utf8',
      );

      const [token] = await loadContractsFromFile(contractPath);
      const state = token?.descriptor.state as Record<string, { initial: unknown }>;

      expect(state.large?.initial).toBe(9_007_199_254_740_993n);
      expect(state.updatedAt?.initial).toEqual(new Date('2024-03-04T05:06:07.890Z'));
      expect(state.payload?.initial).toEqual(new Uint8Array([0, 1, 2, 254, 255]));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
