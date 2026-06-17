// ---------------------------------------------------------------------------
// Dispatcher — implements JsDispatcher against the Registry.
// Routes native→JS ops through codec, NEVER rejects.
// ---------------------------------------------------------------------------

import { decode, encode, sanitizeAny } from '../contract/codec';
import type { BridgeContract, BridgeStreamSource } from '../contract/contract';
import type { CallEnvelope, ResultEnvelope } from '../contract/protocol';
import { diagnostics } from './diagnostics';
import type { Registry } from './registry';
import type { BridgeTransport, JsDispatcher } from './transport';

type StreamProducerEntry = {
  unsubscribe: () => void;
};

// ---- Dispatcher ------------------------------------------------------------

export class Dispatcher implements JsDispatcher {
  private _transport: BridgeTransport | null = null;
  private _openProducers = new Map<string, StreamProducerEntry>();

  constructor(
    private readonly _registry: Registry,
    private readonly _contracts: Map<string, BridgeContract<unknown>>,
  ) {}

  setTransport(transport: BridgeTransport): void {
    this._transport = transport;
  }

  // ---- onInvoke ------------------------------------------------------------

  async onInvoke(env: CallEnvelope): Promise<ResultEnvelope> {
    const start = Date.now();
    try {
      const entry = this._registry.resolve(env.contractId, env.scope);
      if (!entry) {
        // Wait for readiness
        try {
          await this._registry.whenProvided(env.contractId, { scope: env.scope });
        } catch {
          return this._notProvided(env);
        }
        const retried = this._registry.resolve(env.contractId, env.scope);
        if (!retried) return this._notProvided(env);
        return await this._callImpl(env, retried.binding.impl, start);
      }
      return await this._callImpl(env, entry.binding.impl, start);
    } catch (err) {
      diagnostics.incrementErrors();
      return {
        ok: false,
        code: 'PROVIDER_ERROR',
        message: `[bridgekit] PROVIDER_ERROR in ${env.contractId}.${env.member}: ${String(err)}`,
        contractId: env.contractId,
        member: env.member,
        scope: env.scope,
      };
    }
  }

  // ---- onStreamOpen --------------------------------------------------------

  onStreamOpen(env: CallEnvelope, streamId: string): void {
    const transport = this._transport;
    if (!transport) return;

    const entry = this._registry.resolve(env.contractId, env.scope);
    if (!entry) {
      transport.endFromJs(streamId, {
        ok: false,
        code: 'CONTRACT_NOT_PROVIDED',
        message: `[bridgekit] CONTRACT_NOT_PROVIDED: ${env.contractId} in ${JSON.stringify(env.scope)}`,
        contractId: env.contractId,
        member: env.member,
        scope: env.scope,
      });
      return;
    }

    const impl = entry.binding.impl as Record<string, unknown>;
    const fn = impl[env.member];
    if (typeof fn !== 'function') {
      transport.endFromJs(streamId, {
        ok: false,
        code: 'METHOD_NOT_FOUND',
        message: `[bridgekit] METHOD_NOT_FOUND: ${env.contractId}.${env.member}`,
        contractId: env.contractId,
        member: env.member,
        scope: env.scope,
      });
      return;
    }

    try {
      const contract = this._contracts.get(env.contractId);
      const streamDesc = contract?.descriptor.streams[env.member];
      let params: unknown = env.payload;
      if (streamDesc?.params) {
        // t.* path: schema-driven decode
        params = decode(streamDesc.params, env.payload);
      }
      // Marker path: no params schema → pass-through (value already JSON-shaped)

      const source: BridgeStreamSource<unknown> =
        params !== undefined
          ? (fn as (p: unknown) => BridgeStreamSource<unknown>)(params)
          : (fn as () => BridgeStreamSource<unknown>)();

      let active = true;
      const iterator = source[Symbol.asyncIterator]();

      // Drive iterator async — pumps values to transport and calls endFromJs when done
      const pump = async () => {
        try {
          while (active) {
            const result = await iterator.next();
            if (result.done) {
              if (active) {
                transport.endFromJs(streamId, { ok: true });
                this._openProducers.delete(streamId);
              }
              break;
            }
            if (!active) break;
            let encoded: unknown = result.value;
            if (streamDesc?.value) {
              // t.* path: schema-driven encode
              encoded = encode(streamDesc.value, result.value);
            } else {
              // Marker path: no schema → universal sanitize
              encoded = sanitizeAny(result.value);
            }
            transport.emitFromJs(streamId, encoded);
          }
        } catch (err) {
          if (active) {
            transport.endFromJs(streamId, {
              ok: false,
              code: 'PROVIDER_ERROR',
              message: `[bridgekit] PROVIDER_ERROR stream ${env.contractId}.${env.member}: ${String(err)}`,
              contractId: env.contractId,
              member: env.member,
              scope: env.scope,
            });
            // 5.7: clean up the producer entry so onStreamClose does not attempt
            // a second unsubscribe/endFromJs on an already-finished stream.
            this._openProducers.delete(streamId);
          }
        }
      };

      // Start pump in background
      pump().catch(() => {});

      this._openProducers.set(streamId, {
        unsubscribe: () => {
          active = false;
          iterator.return?.();
        },
      });
    } catch (err) {
      transport.endFromJs(streamId, {
        ok: false,
        code: 'PROVIDER_ERROR',
        message: `[bridgekit] PROVIDER_ERROR stream ${env.contractId}.${env.member}: ${String(err)}`,
        contractId: env.contractId,
        member: env.member,
        scope: env.scope,
      });
    }
  }

  // ---- onStreamClose -------------------------------------------------------

  onStreamClose(streamId: string, _reason: string): void {
    const producer = this._openProducers.get(streamId);
    if (producer) {
      producer.unsubscribe();
      this._openProducers.delete(streamId);
    }
  }

  // ---- onStateWrite --------------------------------------------------------

  onStateWrite(env: CallEnvelope): void {
    const entry = this._registry.resolve(env.contractId, env.scope);
    if (!entry) return;

    const contract = this._contracts.get(env.contractId);
    const stateDesc = contract?.descriptor.state[env.member];
    let value: unknown = env.payload;
    if (stateDesc?.value) {
      // t.* path: schema-driven decode
      value = decode(stateDesc.value, env.payload);
    }
    // Marker path: no schema → pass-through (value already JSON-shaped)
    entry.binding.setState(env.member, value);
  }

  /** Clean up all open producers (on epoch change) */
  closeAllProducers(): void {
    for (const [, producer] of this._openProducers) {
      producer.unsubscribe();
    }
    this._openProducers.clear();
  }

  // ---- private helpers -----------------------------------------------------

  private _notProvided(env: CallEnvelope): ResultEnvelope {
    return {
      ok: false,
      code: 'CONTRACT_NOT_PROVIDED',
      message: `[bridgekit] CONTRACT_NOT_PROVIDED: contract '${env.contractId}' not provided in scope ${JSON.stringify(env.scope)}`,
      contractId: env.contractId,
      member: env.member,
      scope: env.scope,
    };
  }

  private async _callImpl(
    env: CallEnvelope,
    impl: unknown,
    startMs: number,
  ): Promise<ResultEnvelope> {
    const implObj = impl as Record<string, unknown>;
    const fn = implObj[env.member];

    if (typeof fn !== 'function') {
      return {
        ok: false,
        code: 'METHOD_NOT_FOUND',
        message: `[bridgekit] METHOD_NOT_FOUND: ${env.contractId}.${env.member}`,
        contractId: env.contractId,
        member: env.member,
        scope: env.scope,
      };
    }

    const contract = this._contracts.get(env.contractId);
    const methodDesc = contract?.descriptor.methods[env.member];

    // Decode params
    let params: unknown = env.payload;
    if (methodDesc && 'params' in methodDesc && methodDesc.params) {
      // t.* path: schema-driven decode
      params = decode(methodDesc.params, env.payload);
    }
    // Marker path: no params schema → pass-through (value already JSON-shaped)

    try {
      diagnostics.incrementCalls();
      const raw =
        params !== undefined
          ? await (fn as (p: unknown) => Promise<unknown>)(params)
          : await (fn as () => Promise<unknown>)();

      // Encode result
      let encoded: unknown = raw;
      if (methodDesc && 'result' in methodDesc && methodDesc.result) {
        // t.* path: schema-driven encode
        encoded = encode(methodDesc.result, raw);
      } else if (raw !== undefined) {
        // Marker path: no schema → universal sanitize (strips undefined/functions)
        encoded = sanitizeAny(raw);
      }

      diagnostics.trace({
        op: 'invoke',
        contractId: env.contractId,
        member: env.member,
        scopeKey: JSON.stringify(env.scope),
        durationMs: Date.now() - startMs,
        side: 'js',
      });

      return { ok: true, value: encoded };
    } catch (err) {
      diagnostics.incrementErrors();
      diagnostics.trace({
        op: 'invoke.error',
        contractId: env.contractId,
        member: env.member,
        scopeKey: JSON.stringify(env.scope),
        durationMs: Date.now() - startMs,
        code: 'PROVIDER_ERROR',
        side: 'js',
      });
      return {
        ok: false,
        code: 'PROVIDER_ERROR',
        message: `[bridgekit] PROVIDER_ERROR in ${env.contractId}.${env.member}: ${String(err)}`,
        contractId: env.contractId,
        member: env.member,
        scope: env.scope,
      };
    }
  }
}
