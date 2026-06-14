// ---------------------------------------------------------------------------
// Wire protocol constants — shared vocabulary for all bridgekit layers.
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'CONTRACT_NOT_PROVIDED',
  'METHOD_NOT_FOUND',
  'INCOMPATIBLE_CONTRACT',
  'NOT_PROVIDER',
  'TIMEOUT',
  'CANCELLED',
  'PROVIDER_ERROR',
  'VALIDATION_FAILED',
  'BRIDGE_NOT_READY',
] as const;

export type BridgeErrorCode = (typeof ERROR_CODES)[number];

// ---- scope ----------------------------------------------------------------

export interface BridgeScope {
  kind: 'global' | 'feature' | 'instance';
  feature?: string;
  instance?: string;
}

// ---- envelopes ------------------------------------------------------------

export interface CallEnvelope {
  op:
    | 'invoke'
    | 'invokeSync'
    | 'streamOpen'
    | 'streamClose'
    | 'stateRead'
    | 'stateObserve'
    | 'stateWrite'
    /** Explicit readiness announcement: JS provider is available (no state write). */
    | 'provide'
    /** Explicit readiness retraction: JS provider is gone. */
    | 'unprovide';
  contractId: string;
  member: string;
  scope: BridgeScope;
  payload?: unknown;
  correlationId: string;
  epoch: number;
  /**
   * The caller's contractHash (FNV-1a over the descriptor). Carried on the hot path
   * so the receiver can detect wire skew (design Decision 2). The receiver caches the
   * first hash it sees per contract and, in enforce mode, returns INCOMPATIBLE_CONTRACT
   * when a later hash differs. Optional for backward/loopback compatibility.
   */
  contractHash?: string;
}

// ---- handshake / connect envelope -----------------------------------------

/**
 * Connect-time handshake payload. Carries per-contract hashes so the receiving
 * side learns the caller's contract identities up front (design Decision 2).
 * `memberHashes` rides the handshake (and the INCOMPATIBLE_CONTRACT error) for
 * diffing; the per-call envelope only re-sends `contractHash` for the hot path.
 */
export interface ConnectEnvelope {
  contractHashes?: Record<string, string>;
  memberHashes?: Record<string, Record<string, string>>;
}

export interface ResultOk {
  ok: true;
  value?: unknown;
}

export interface ResultErr {
  ok: false;
  code: BridgeErrorCode;
  message: string;
  contractId?: string;
  member?: string;
  scope?: BridgeScope;
  readiness?: string;
  details?: unknown;
}

export type ResultEnvelope = ResultOk | ResultErr;

// ---- BridgeError ----------------------------------------------------------

/**
 * BridgeError is identified by its `.code` property, never by `instanceof`.
 * This is intentional: bridgekit may exist in multiple copies in a bundle
 * (different package versions) and `instanceof` checks fail across copies.
 * Always use `isBridgeError(e)` or `isBridgeError(e, code)` for detection.
 */
export interface BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly contractId?: string;
  readonly member?: string;
  readonly scope?: BridgeScope;
  readonly details?: unknown;
}

export interface BridgeErrorContext {
  contractId?: string;
  member?: string;
  scope?: BridgeScope;
  details?: unknown;
}

/**
 * Duck-typed guard for BridgeError. Works across package copies (no instanceof).
 *
 * @param e - Any value.
 * @param code - Optional: also check that the code matches exactly.
 */
export function isBridgeError(e: unknown, code?: BridgeErrorCode): e is BridgeError {
  if (e === null || e === undefined || typeof e !== 'object') return false;
  const obj = e as Record<string, unknown>;
  if (typeof obj.code !== 'string') return false;
  if (typeof obj.message !== 'string') return false;
  const isKnownCode = (ERROR_CODES as readonly string[]).includes(obj.code);
  if (!isKnownCode) return false;
  if (code !== undefined && obj.code !== code) return false;
  return true;
}

/**
 * Create a BridgeError (extends Error, identified by .code).
 * Do NOT use instanceof to detect — use isBridgeError instead.
 */
export function createBridgeError(
  code: BridgeErrorCode,
  message: string,
  ctx?: BridgeErrorContext,
): BridgeError {
  const err = new Error(message) as BridgeError & BridgeErrorContext;
  Object.defineProperty(err, 'code', { value: code, enumerable: true, configurable: true });
  if (ctx?.contractId !== undefined) {
    Object.defineProperty(err, 'contractId', {
      value: ctx.contractId,
      enumerable: true,
      configurable: true,
    });
  }
  if (ctx?.member !== undefined) {
    Object.defineProperty(err, 'member', {
      value: ctx.member,
      enumerable: true,
      configurable: true,
    });
  }
  if (ctx?.scope !== undefined) {
    Object.defineProperty(err, 'scope', {
      value: ctx.scope,
      enumerable: true,
      configurable: true,
    });
  }
  if (ctx?.details !== undefined) {
    Object.defineProperty(err, 'details', {
      value: ctx.details,
      enumerable: true,
      configurable: true,
    });
  }
  return err as BridgeError;
}
