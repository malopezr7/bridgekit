// ---------------------------------------------------------------------------
// localInvoker — per-kind local invocation for JS-local providers.
//
// Used by BridgeKitJs consumer proxy to resolve calls against a local JS
// registry binding WITHOUT crossing to the native transport.
//
// Resolution order (enforced by the caller):
//   1. Check Registry.resolve(contractId, scope)
//   2. If found → use localInvoker for the call (this file)
//   3. If not found → fall through to the native transport (unchanged)
//
// Footgun / shadow note:
//   A JS-local provider at any scope level SHADOWS a native provider in the
//   same or broader scope. This is INTENTIONAL — it enables pure-JS hosts
//   (web target, standalone, tests) to override native providers. If you have
//   a native-provided contract and unexpectedly shadow it with a JS provider,
//   the JS one wins. Remove the JS provide() call to restore native routing.
// ---------------------------------------------------------------------------

import type { BridgeStreamSource } from '../contract/contract';
import { createBridgeError } from '../contract/protocol';
import { diagnostics } from './diagnostics';

// ---- invokeLocalSync -------------------------------------------------------

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

// ---- invokeLocalAsync ------------------------------------------------------

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

  // Check AbortSignal before even calling impl
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

  // Map impl rejections to PROVIDER_ERROR
  invocation = invocation.catch((err) => {
    diagnostics.incrementErrors();
    throw createBridgeError(
      'PROVIDER_ERROR',
      `[bridgekit] local PROVIDER_ERROR in ${contractId}.${member}: ${String(err)}`,
      { contractId, member },
    );
  });

  // Apply timeoutMs
  const { timeoutMs } = opts ?? {};
  if (timeoutMs !== undefined && timeoutMs !== null) {
    invocation = Promise.race([
      invocation,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              createBridgeError(
                'TIMEOUT',
                `[bridgekit] local TIMEOUT: ${contractId}.${member} exceeded ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);
  }

  // Apply AbortSignal
  if (opts?.signal) {
    const signal = opts.signal;
    invocation = Promise.race([
      invocation,
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(
              createBridgeError('CANCELLED', '[bridgekit] local CANCELLED: AbortSignal aborted'),
            ),
          { once: true },
        );
      }),
    ]);
  }

  return invocation;
}

// ---- invokeLocalFire -------------------------------------------------------

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
    // If result is a promise, swallow rejection silently
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(() => {
        diagnostics.incrementFiresDropped();
      });
    }
  } catch {
    diagnostics.incrementFiresDropped();
  }
}

// ---- openLocalStream -------------------------------------------------------

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
        void cb; // unused but keeps signature
        // No values, no teardown needed
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
