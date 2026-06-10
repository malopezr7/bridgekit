// ---------------------------------------------------------------------------
// Correlation ID generation — monotonic counter + random suffix.
// No Date.now or Math.random restrictions: using a simple counter + seeded suffix.
// ---------------------------------------------------------------------------

let _counter = 0;
// Simple pseudo-random suffix seeded at module load time (not crypto)
const _suffix = (Date.now() & 0xffff).toString(16).padStart(4, '0');

export function nextCorrelationId(): string {
  return `${++_counter}-${_suffix}`;
}
