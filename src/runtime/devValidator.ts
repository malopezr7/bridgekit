// ---------------------------------------------------------------------------
// Dev-validator seam (DX-1).
//
// Provides a thin per-contract inbound validator registration point.
// In DX-2, codegen will emit validators and register them here.
//
// The seam is:
//   - registerContractValidator(contractId, validator) — called by generated code
//   - clearContractValidator(contractId)               — for testing
//   - runInboundValidator(contractId, member, value)   — called by runtime (dev only)
//
// All calls are NO-OPs in production builds (__DEV__ === false or NODE_ENV === 'production').
// The registered validator receives the inbound value (native→JS: result, state, stream
// emission) and returns either { ok: true } or { ok: false, message: string }.
//
// DX-2 codegen contract: register validators for each member that has a typed
// result, for state values, and for stream emissions. Member key format:
//   'methods.<name>'  — for query/querySync results
//   'streams.<name>'  — for stream emission values
//   'state.<name>'    — for state values received from native
// ---------------------------------------------------------------------------

function _isDev(): boolean {
  try {
    if (typeof __DEV__ === 'boolean') return __DEV__;
  } catch {
    // ReferenceError in non-RN environments
  }
  return process.env.NODE_ENV !== 'production';
}

export interface ValidatorResult {
  ok: boolean;
  message?: string;
}

export type InboundValidator = (member: string, value: unknown) => ValidatorResult;

// Per-contract validator registry (dev only; empty in prod)
const _validators = new Map<string, InboundValidator>();

/**
 * Register a per-contract inbound validator.
 * Called by DX-2 generated code on module load.
 * No-op in production builds.
 *
 * @param contractId - e.g. 'lia.host'
 * @param validator  - function(member, value) → { ok, message? }
 *   member format: 'methods.getLiteral', 'state.counter', 'streams.ticks'
 */
export function registerContractValidator(contractId: string, validator: InboundValidator): void {
  if (!_isDev()) return;
  _validators.set(contractId, validator);
}

/**
 * Remove the validator for a contract.
 * Used in tests to reset state between runs.
 */
export function clearContractValidator(contractId: string): void {
  _validators.delete(contractId);
}

/**
 * Run the inbound validator for a contract member (dev builds only).
 * If validation fails, logs a warning. Does NOT throw — validators are advisory.
 * No-op if no validator is registered or in production.
 *
 * @param contractId - The contract being invoked/observed.
 * @param memberKey  - e.g. 'methods.getLiteral', 'state.counter', 'streams.ticks'
 * @param value      - The inbound value to validate.
 */
export function runInboundValidator(contractId: string, memberKey: string, value: unknown): void {
  if (!_isDev()) return;
  const validator = _validators.get(contractId);
  if (!validator) return;
  const result = validator(memberKey, value);
  if (!result.ok) {
    console.warn(
      `[bridgekit] inbound validation failed for ${contractId}.${memberKey}: ${result.message ?? 'unknown error'}`,
    );
  }
}
