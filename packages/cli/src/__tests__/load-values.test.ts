import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CliError } from '../cliError.js';
import { loadContractsFromFile } from '../load.js';
import {
  decodeLoaderPayload,
  encodeLoaderPayload,
  MAX_LOADER_NESTING_DEPTH,
  MAX_LOADER_PAYLOAD_BYTES,
} from '../loaderCodec.js';

const cliRoot = process.cwd();

describe('contract loader value codec', () => {
  it('round-trips BigInt, Date, binary carriers, undefined, and JSON-compatible structures', () => {
    const arrayBuffer = new Uint8Array([9, 8, 7, 0, 255]).buffer;
    const value = {
      bigint: 9_007_199_254_740_993n,
      date: new Date('2024-03-04T05:06:07.890Z'),
      bytes: new Uint8Array([0, 1, 2, 254, 255]),
      arrayBuffer,
      nested: [true, null, undefined, { text: 'value', number: 42.5 }],
    };

    const decoded = decodeLoaderPayload(encodeLoaderPayload([value]));

    expect(decoded).toEqual([value]);
    expect((decoded[0] as typeof value).date).toBeInstanceOf(Date);
    expect((decoded[0] as typeof value).bytes).toBeInstanceOf(Uint8Array);
    expect((decoded[0] as typeof value).arrayBuffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array((decoded[0] as typeof value).arrayBuffer)).toEqual(
      new Uint8Array(arrayBuffer),
    );
  });

  it('preserves negative zero separately from positive zero', () => {
    const decoded = decodeLoaderPayload(encodeLoaderPayload([-0, 0]));

    expect(Object.is(decoded[0], -0)).toBe(true);
    expect(Object.is(decoded[0], 0)).toBe(false);
    expect(Object.is(decoded[1], 0)).toBe(true);
    expect(Object.is(decoded[1], -0)).toBe(false);
  });

  it('accepts the nesting boundary and rejects the next level with a stable diagnostic', () => {
    const nested = (depth: number): unknown => {
      let value: unknown = 'leaf';
      for (let index = 0; index < depth; index++) value = [value];
      return value;
    };

    expect(() => encodeLoaderPayload([nested(MAX_LOADER_NESTING_DEPTH)])).not.toThrow();
    expect(() => encodeLoaderPayload([nested(MAX_LOADER_NESTING_DEPTH + 1)])).toThrow(
      new RegExp(`nesting depth.*${MAX_LOADER_NESTING_DEPTH}`, 'i'),
    );
  });

  it('accepts a payload just below the byte budget and rejects one just above it', () => {
    const emptyPayloadBytes = Buffer.byteLength(encodeLoaderPayload(['']), 'utf8');
    const below = 'x'.repeat(MAX_LOADER_PAYLOAD_BYTES - emptyPayloadBytes);
    const accepted = encodeLoaderPayload([below]);

    expect(Buffer.byteLength(accepted, 'utf8')).toBe(MAX_LOADER_PAYLOAD_BYTES);
    expect(decodeLoaderPayload(accepted)).toEqual([below]);
    expect(() => encodeLoaderPayload([`${below}x`])).toThrow(
      new RegExp(`payload.*${MAX_LOADER_PAYLOAD_BYTES} bytes`, 'i'),
    );
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
      'noncanonical negative-zero bigint payloads',
      { $bridgekitLoader: 'v1', tokens: [{ t: 'bi', v: '-0' }] },
      /bigint.*-0/i,
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

  it('distinguishes missing and extra fields at the exact node path', () => {
    expect(() =>
      decodeLoaderPayload(
        JSON.stringify({ $bridgekitLoader: 'v1', tokens: [{ t: 'a', v: [{ t: 'd' }] }] }),
      ),
    ).toThrow('Malformed loader node at tokens[0][0]: missing field v');

    expect(() =>
      decodeLoaderPayload(
        JSON.stringify({ $bridgekitLoader: 'v1', tokens: [{ t: 'a', v: [{ t: 'n', x: 1 }] }] }),
      ),
    ).toThrow('Malformed loader node at tokens[0][0]: unexpected field x');
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
    arrayBuffer: t.state(t.binary(), new Uint8Array([9, 8, 7]).buffer as unknown as Uint8Array),
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
      expect(state.arrayBuffer?.initial).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(state.arrayBuffer?.initial as ArrayBuffer)).toEqual(
        new Uint8Array([9, 8, 7]),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reports loader payload budget overflow as CliError instead of ENOBUFS', async () => {
    const parent = path.join(cliRoot, 'build/load-values');
    mkdirSync(parent, { recursive: true });
    const workspace = mkdtempSync(path.join(parent, 'payload-limit-'));
    const contractPath = path.join(workspace, 'payload-limit.contract.ts');

    try {
      writeFileSync(
        contractPath,
        `import { defineContract, t } from '@malopezr7/bridgekit/contract';
export const PayloadLimit = defineContract('loader.payload-limit', {
  state: { value: t.state(t.string(), 'x'.repeat(${MAX_LOADER_PAYLOAD_BYTES})) },
});
`,
        'utf8',
      );

      let thrown: unknown;
      try {
        await loadContractsFromFile(contractPath);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as Error).message).toMatch(
        new RegExp(`loader payload exceeds ${MAX_LOADER_PAYLOAD_BYTES} bytes`, 'i'),
      );
      expect((thrown as Error).message).not.toMatch(/ENOBUFS|RangeError/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
