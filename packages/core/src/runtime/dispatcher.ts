// ---------------------------------------------------------------------------
// Dispatcher — implements JsDispatcher against the Registry.
// Routes native→JS ops through codec, NEVER rejects.
// ---------------------------------------------------------------------------

import { decode, encode, sanitizeAny } from '../contract/codec';
import type { BridgeContract, BridgeStreamSource } from '../contract/contract';
import type { CallEnvelope, ResultEnvelope } from '../contract/protocol';
import { diagnostics } from './diagnostics';
import { type Registry, serializeScope } from './registry';
import type { BridgeTransport, JsDispatcher } from './transport';

type StreamProducerEntry = {
  unsubscribe: () => void;
  replayKey?: string;
};

type ReplayCloneResult<T> = { ok: true; value: T } | { ok: false };

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function cloneReplayValue<T>(value: T): ReplayCloneResult<T> {
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return { ok: true, value: globalThis.structuredClone(value) };
    } catch {
      // Fall through to the lossy JSON clone below. Replay must never fail open.
    }
  }
  if (value === undefined || value === null || typeof value !== 'object') {
    return { ok: true, value };
  }
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(value)) as T };
  } catch {
    return { ok: false };
  }
}

function streamReplayKey(env: CallEnvelope): string {
  return `${env.contractId}|${env.member}|${serializeScope(env.scope)}|${stableSerialize(env.payload)}`;
}

// ---- Dispatcher ------------------------------------------------------------

export class Dispatcher implements JsDispatcher {
  private _transport: BridgeTransport | null = null;
  private _openProducers = new Map<string, StreamProducerEntry>();
  private _parkedStreams = new Map<string, () => void>();
  private _streamLatestValues = new Map<string, unknown>();

  constructor(
    private readonly _registry: Registry,
    private readonly _contracts: Map<string, BridgeContract<unknown>>,
  ) {
    this._registry.onBindingClose(({ contractId, scope, reason }) => {
      if (reason === 'final') {
        this.invalidateReplayFor(contractId, scope);
      }
    });
  }

  setTransport(transport: BridgeTransport): void {
    this._transport = transport;
  }

  // ---- onInvoke ------------------------------------------------------------

  async onInvoke(env: CallEnvelope): Promise<ResultEnvelope> {
    const start = Date.now();
    try {
      const entry = this._registry.resolve(env.contractId, env.scope);
      if (!entry) {
        // Wait for an exact replacing tombstone first. If there is no tombstone
        // in the requested fallback chain, keep the existing readiness behavior.
        try {
          const replacing = this._registry.whenReplacingProvided(env.contractId, env.scope);
          if (replacing) {
            await replacing;
          } else {
            await this._registry.whenProvided(env.contractId, { scope: env.scope });
          }
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
      const replacing = this._registry.whenReplacingProvided(env.contractId, env.scope);
      if (replacing) {
        let canceled = false;
        this._parkedStreams.set(streamId, () => {
          canceled = true;
        });
        replacing.then(
          () => {
            this._parkedStreams.delete(streamId);
            if (canceled) return;
            this.onStreamOpen(env, streamId);
          },
          () => {
            this._parkedStreams.delete(streamId);
            if (canceled) return;
            const currentTransport = this._transport;
            if (!currentTransport) return;
            currentTransport.endFromJs(streamId, this._notProvided(env));
          },
        );
        return;
      }
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
      const descriptorWantsReplay = streamDesc?.latestOnly === true || streamDesc?.sticky === true;
      const shouldReplayLatest =
        descriptorWantsReplay || env.latestOnly === true || env.sticky === true;
      const replayKey = shouldReplayLatest ? streamReplayKey(env) : undefined;
      if (replayKey !== undefined && this._streamLatestValues.has(replayKey)) {
        const replay = cloneReplayValue(this._streamLatestValues.get(replayKey));
        if (replay.ok) {
          transport.emitFromJs(streamId, replay.value);
        }
      }

      // Drive iterator async — pumps values to transport and calls endFromJs when done
      const pump = async () => {
        try {
          while (active) {
            const result = await iterator.next();
            if (result.done) {
              if (active) {
                transport.endFromJs(streamId, { ok: true });
                if (replayKey !== undefined) {
                  this._openProducers.delete(streamId);
                  this._deleteReplayIfUnused(replayKey);
                } else {
                  this._openProducers.delete(streamId);
                }
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
            if (shouldReplayLatest && replayKey !== undefined) {
              this._streamLatestValues.set(replayKey, encoded);
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
            if (replayKey !== undefined) {
              this._openProducers.delete(streamId);
              this._deleteReplayIfUnused(replayKey);
            } else {
              this._openProducers.delete(streamId);
            }
          }
        }
      };

      // Start pump in background
      pump().catch(() => {});

      this._openProducers.set(streamId, {
        replayKey,
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
    const cancelParked = this._parkedStreams.get(streamId);
    if (cancelParked) {
      cancelParked();
      this._parkedStreams.delete(streamId);
      return;
    }
    const producer = this._openProducers.get(streamId);
    if (producer) {
      producer.unsubscribe();
      if (producer.replayKey !== undefined) {
        this._openProducers.delete(streamId);
        this._deleteReplayIfUnused(producer.replayKey);
      } else {
        this._openProducers.delete(streamId);
      }
    }
  }

  // ---- onStateWrite --------------------------------------------------------

  onStateWrite(env: CallEnvelope): void {
    if (env.op === 'provide' || env.op === 'unprovide') return;

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
    for (const [, cancelParked] of this._parkedStreams) {
      cancelParked();
    }
    this._parkedStreams.clear();
    for (const [, producer] of this._openProducers) {
      producer.unsubscribe();
    }
    this._openProducers.clear();
    this._streamLatestValues.clear();
  }

  invalidateReplayFor(contractId: string, scope: CallEnvelope['scope']): void {
    const scopeNeedle = `|${serializeScope(scope)}|`;
    for (const replayKey of Array.from(this._streamLatestValues.keys())) {
      if (replayKey.startsWith(`${contractId}|`) && replayKey.includes(scopeNeedle)) {
        this._streamLatestValues.delete(replayKey);
      }
    }
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

  private _deleteReplayIfUnused(replayKey: string): void {
    for (const producer of this._openProducers.values()) {
      if (producer.replayKey === replayKey) return;
    }
    this._streamLatestValues.delete(replayKey);
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
