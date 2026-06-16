// JS inbound validation on decode.
// Schema-first markers carry the result schema directly; the runtime validates inbound
// native payloads and rejects missing/wrong-type fields with VALIDATION_FAILED.

import { describe, expect, test } from '@jest/globals';
import { defineContract } from '../contract/contract';
import { Async, Sync } from '../contract/markers';
import { isBridgeError } from '../contract/protocol';
import { t } from '../contract/schema';
import { BridgeKitJs } from '../runtime/bridgekit';
import type { BridgeTransport } from '../runtime/transport';

const userResultSchema = t.object({ name: t.string(), age: t.number() });

const Contract = defineContract('inbound.validation', {
  methods: {
    getUser: Async(userResultSchema),
    getUserSync: Sync(userResultSchema),
  },
});

function makeStubTransport(
  syncResult: () => ReturnType<BridgeTransport['invokeSync']>,
  asyncResult?: () => Promise<
    ReturnType<BridgeTransport['invoke']> extends Promise<infer R> ? R : never
  >,
): BridgeTransport {
  return {
    connect: () => ({ epoch: 1, snapshot: [] }),
    invoke: asyncResult ?? (() => Promise.resolve({ ok: true, value: undefined })),
    invokeSync: syncResult,
    openStream: () => 'sid',
    closeStream: () => {},
    emitFromJs: () => {},
    endFromJs: () => {},
    stateRead: () => ({ ok: true, value: undefined }),
    stateObserve: () => 'obs',
    stateUnobserve: () => {},
    stateWrite: () => ({ ok: true, value: undefined }),
    pushProviderState: () => {},
    announceProvided: () => {},
    announceUnprovided: () => {},
  };
}

describe('JS inbound validation on decode', () => {
  test('valid result passes through unchanged (async)', async () => {
    const transport = makeStubTransport(
      () => ({ ok: true, value: undefined }),
      () => Promise.resolve({ ok: true, value: { name: 'Alice', age: 30 } }),
    );
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const proxy = bk.bridge(Contract);

    const result = await (proxy.getUser as () => Promise<unknown>)();
    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  test('missing required field is rejected with VALIDATION_FAILED (async)', async () => {
    const transport = makeStubTransport(
      () => ({ ok: true, value: undefined }),
      () => Promise.resolve({ ok: true, value: { name: 'Alice' } }), // missing age
    );
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const proxy = bk.bridge(Contract);

    let caught: unknown;
    try {
      await (proxy.getUser as () => Promise<unknown>)();
    } catch (e) {
      caught = e;
    }
    expect(isBridgeError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('VALIDATION_FAILED');
    expect((caught as Error).message).toMatch(/age/);
  });

  test('wrong-type field is rejected with VALIDATION_FAILED, not coerced (async)', async () => {
    const transport = makeStubTransport(
      () => ({ ok: true, value: undefined }),
      () => Promise.resolve({ ok: true, value: { name: 'Alice', age: 'thirty' } }),
    );
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const proxy = bk.bridge(Contract);

    let caught: unknown;
    try {
      await (proxy.getUser as () => Promise<unknown>)();
    } catch (e) {
      caught = e;
    }
    expect(isBridgeError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('VALIDATION_FAILED');
  });

  test('missing required field is rejected with VALIDATION_FAILED (sync)', () => {
    const transport = makeStubTransport(() => ({ ok: true, value: { name: 'Alice' } }));
    const bk = new BridgeKitJs(transport);
    bk.connect();
    const proxy = bk.bridge(Contract);

    let caught: unknown;
    try {
      (proxy.getUserSync as () => unknown)();
    } catch (e) {
      caught = e;
    }
    expect(isBridgeError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe('VALIDATION_FAILED');
  });
});
