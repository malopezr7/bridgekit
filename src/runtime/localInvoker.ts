// localInvoker — per-kind local invocation for JS-local providers.
// Resolves calls against a registry binding WITHOUT crossing to the native transport.
//
// A JS-local provider SHADOWS a native provider in the same or broader scope — intentional
// for web/standalone/test hosts. Remove the JS provide() call to restore native routing.

import type { BridgeStreamSource } from '../contract/contract';
import { createBridgeError } from '../contract/protocol';
import { diagnostics } from './diagnostics';

/**
 * Call a querySync method on a local JS impl synchronously.
 * Returns the raw value — no encode/decode (same-JS-runtime objects).
 * Throws a BridgeError if the method is missing or throws.
 */
export function invokeLocalSync(
  impl: unknown,
  member: string,
  contractId: string,
  params: unknown,
): unknown {
  const implObj = impl as Record<string, unknown>;
  const fn = implObj[member];

  if (typeof fn !== 'function') {
    throw createBridgeError(
      'METHOD_NOT_FOUND',
      `[bridgekit] local METHOD_NOT_FOUND: ${contractId}.${member}`,
      { contractId, member },
    );
  }

  try {
    diagnostics.incrementCalls();
    const result =
      params !== undefined ? (fn as (p: unknown) => unknown)(params) : (fn as () => unknown)();
    return result;
  } catch (err) {
    diagnostics.incrementErrors();
    throw createBridgeError(
      'PROVIDER_ERROR',
      `[bridgekit] local PROVIDER_ERROR in ${contractId}.${member}: ${String(err)}`,
      { contractId, member },
    );
  }
}

/**
 * Call a query method on a local JS impl asynchronously.
 * Applies timeoutMs and AbortSignal the same way the transport path does.
 * Rejects with BridgeError shapes matching the transport path.
 */
export function invokeLocalAsync(
  impl: unknown,
  member: string,
  contractId: string,
  params: unknown,
  opts?: { timeoutMs?: number | null; signal?: AbortSignal },
): Promise<unknown> {
  const implObj = impl as Record<string, unknown>;
  const fn = implObj[member];

  if (typeof fn !== 'function') {
    return Promise.reject(
      createBridgeError(
        'METHOD_NOT_FOUND',
        `[bridgekit] local METHOD_NOT_FOUND: ${contractId}.${member}`,
        { contractId, member },
      ),
    );
  }

  if (opts?.signal?.aborted) {
    return Promise.reject(
      createBridgeError('CANCELLED', '[bridgekit] local CANCELLED: AbortSignal already aborted'),
    );
  }

  let invocation: Promise<unknown>;
  try {
    diagnostics.incrementCalls();
    const raw =
      params !== undefined ? (fn as (p: unknown) => unknown)(params) : (fn as () => unknown)();
    invocation = Promise.resolve(raw);
  } catch (err) {
    diagnostics.incrementErrors();
    return Promise.reject(
      createBridgeError(
        'PROVIDER_ERROR',
        `[bridgekit] local PROVIDER_ERROR in ${contractId}.${member}: ${String(err)}`,
        { contractId, member },
      ),
    );
  }

  invocation = invocation.catch((err) => {
    diagnostics.incrementErrors();
    throw createBridgeError(
      'PROVIDER_ERROR',
      `[bridgekit] local PROVIDER_ERROR in ${contractId}.${member}: ${String(err)}`,
      { contractId, member },
    );
  });

  // Track cleanup resources (timer + abort listener) released in .finally().
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let abortSignal: AbortSignal | undefined;

  const { timeoutMs } = opts ?? {};
  if (timeoutMs !== undefined && timeoutMs !== null) {
    invocation = Promise.race([
      invocation,
      new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () =>
            reject(
              createBridgeError(
                'TIMEOUT',
                `[bridgekit] local TIMEOUT: ${contractId}.${member} exceeded ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  }

  if (opts?.signal) {
    const signal = opts.signal;
    abortSignal = signal;
    invocation = Promise.race([
      invocation,
      new Promise<never>((_, reject) => {
        abortHandler = () =>
          reject(
            createBridgeError('CANCELLED', '[bridgekit] local CANCELLED: AbortSignal aborted'),
          );
        signal.addEventListener('abort', abortHandler, { once: true });
      }),
    ]);
  }

  return invocation.finally(() => {
    if (timerId !== undefined) clearTimeout(timerId);
    if (abortSignal !== undefined && abortHandler !== undefined) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
  });
}

/**
 * Call a fire method on a local JS impl.
 * Errors are swallowed + diagnostics (fire semantics: caller never hears about errors).
 */
export function invokeLocalFire(
  impl: unknown,
  member: string,
  _contractId: string,
  params: unknown,
): void {
  const implObj = impl as Record<string, unknown>;
  const fn = implObj[member];

  if (typeof fn !== 'function') {
    diagnostics.incrementFiresDropped();
    return;
  }

  try {
    const result =
      params !== undefined ? (fn as (p: unknown) => unknown)(params) : (fn as () => unknown)();
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(() => {
        diagnostics.incrementFiresDropped();
      });
    }
  } catch {
    diagnostics.incrementFiresDropped();
  }
}

/**
 * Wire a local stream provider impl to a BridgeStreamSource-style consumer.
 * The impl method returns a BridgeStreamSource<T>; we subscribe and pump
 * values to the consumer's callbacks (matching the transport openStream API).
 *
 * Returns a BridgeStreamSource that delegates subscribe/asyncIterator to the
 * local impl's source — for use in the bridge() proxy stream path.
 */
export function openLocalStream(
  impl: unknown,
  member: string,
  _contractId: string,
  params: unknown,
): BridgeStreamSource<unknown> {
  const implObj = impl as Record<string, unknown>;
  const fn = implObj[member];

  if (typeof fn !== 'function') {
    // Return a stream that immediately errors
    return {
      subscribe(cb: (v: unknown) => void): () => void {
        void cb;
        return () => {};
      },
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          next(): Promise<IteratorResult<unknown>> {
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  const source: BridgeStreamSource<unknown> =
    params !== undefined
      ? (fn as (p: unknown) => BridgeStreamSource<unknown>)(params)
      : (fn as () => BridgeStreamSource<unknown>)();

  return source;
}
