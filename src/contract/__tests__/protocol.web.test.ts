import { createBridgeError, ERROR_CODES, isBridgeError } from '../protocol';

describe('ERROR_CODES', () => {
  it('is a readonly tuple of string codes', () => {
    expect(Array.isArray(ERROR_CODES)).toBe(true);
    expect(ERROR_CODES).toContain('CONTRACT_NOT_PROVIDED');
    expect(ERROR_CODES).toContain('METHOD_NOT_FOUND');
    expect(ERROR_CODES).toContain('INCOMPATIBLE_CONTRACT');
    expect(ERROR_CODES).toContain('NOT_PROVIDER');
    expect(ERROR_CODES).toContain('TIMEOUT');
    expect(ERROR_CODES).toContain('CANCELLED');
    expect(ERROR_CODES).toContain('PROVIDER_ERROR');
    expect(ERROR_CODES).toContain('VALIDATION_FAILED');
    expect(ERROR_CODES).toContain('BRIDGE_NOT_READY');
  });
});

describe('isBridgeError', () => {
  it('returns true for an object with a valid code + message', () => {
    const err = { code: 'TIMEOUT', message: 'timed out' };
    expect(isBridgeError(err)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isBridgeError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isBridgeError(undefined)).toBe(false);
  });

  it('returns false for a plain string', () => {
    expect(isBridgeError('TIMEOUT')).toBe(false);
  });

  it('returns false if code is not in ERROR_CODES', () => {
    expect(isBridgeError({ code: 'UNKNOWN_CODE', message: 'x' })).toBe(false);
  });

  it('returns false if message is missing', () => {
    expect(isBridgeError({ code: 'TIMEOUT' })).toBe(false);
  });

  it('accepts cross-realm-style plain objects (duck-typed)', () => {
    // Simulate object from a different realm (plain object that looks like error)
    const obj = Object.create(null) as Record<string, unknown>;
    obj['code'] = 'CANCELLED';
    obj['message'] = 'cancelled by user';
    expect(isBridgeError(obj)).toBe(true);
  });

  it('narrows code when second arg provided', () => {
    const err = { code: 'TIMEOUT', message: 'timed out' };
    expect(isBridgeError(err, 'TIMEOUT')).toBe(true);
    expect(isBridgeError(err, 'CANCELLED')).toBe(false);
  });
});

describe('createBridgeError', () => {
  it('returns an Error-compatible object with .code', () => {
    const err = createBridgeError('TIMEOUT', 'call timed out');
    expect(err instanceof Error).toBe(true);
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toBe('call timed out');
  });

  it('isBridgeError returns true for created error', () => {
    const err = createBridgeError('METHOD_NOT_FOUND', 'no method');
    expect(isBridgeError(err)).toBe(true);
  });

  it('code is the primary identifier (not instanceof – consistent across copies)', () => {
    const err = createBridgeError('VALIDATION_FAILED', 'bad params');
    // identification by .code, NOT instanceof
    expect(isBridgeError(err, 'VALIDATION_FAILED')).toBe(true);
  });

  it('accepts optional context', () => {
    const err = createBridgeError('CONTRACT_NOT_PROVIDED', 'not provided', {
      contractId: 'foo.bar',
      scope: { kind: 'global' },
    });
    expect(err.contractId).toBe('foo.bar');
    expect(err.scope).toEqual({ kind: 'global' });
  });
});
