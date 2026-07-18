// ---------------------------------------------------------------------------
// Diagnostics — dev-mode structured trace + counters.
// ---------------------------------------------------------------------------

import { isBridgeKitDev } from './env';

// ---- trace event -----------------------------------------------------------

export interface TraceEvent {
  op: string;
  contractId: string;
  member: string;
  scopeKey: string;
  durationMs: number;
  side: 'js';
  code?: string;
}

// ---- counters ---------------------------------------------------------------

interface Counters {
  calls: number;
  errors: number;
  firesDropped: number;
}

// ---- Open-stream counter ---------------------------------------------------
// Separate from Counters so it can be queried independently by dump().

// ---- DiagnosticsImpl -------------------------------------------------------

class DiagnosticsImpl {
  private _enabled: boolean = isBridgeKitDev();
  private _seq = 0;
  private _counters: Counters = { calls: 0, errors: 0, firesDropped: 0 };
  private _openStreams = 0;
  /** W3-4: cumulative count of stream items dropped due to bounded consumer queue. */
  private _streamDrops = 0;

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  trace(event: TraceEvent): void {
    if (!this._enabled) return;
    const seq = ++this._seq;
    console.debug('[bridgekit]', { seq, ...event });
  }

  incrementCalls(): void {
    this._counters.calls++;
  }

  incrementErrors(): void {
    this._counters.errors++;
  }

  incrementFiresDropped(): void {
    this._counters.firesDropped++;
  }

  incrementOpenStreams(): void {
    this._openStreams++;
  }

  decrementOpenStreams(): void {
    if (this._openStreams > 0) this._openStreams--;
  }

  /** Start tracking one stream consumer and return an idempotent finish callback. */
  trackOpenStream(): () => void {
    this.incrementOpenStreams();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.decrementOpenStreams();
    };
  }

  getOpenStreams(): number {
    return this._openStreams;
  }

  /** W3-4: Increment when an item is dropped from a bounded consumer queue. */
  incrementStreamDrops(): void {
    this._streamDrops++;
  }

  /** W3-4: Total items dropped across all bounded consumer queues since last reset(). */
  getStreamDrops(): number {
    return this._streamDrops;
  }

  getCounters(): Counters {
    return { ...this._counters };
  }

  /**
   * Emit a one-time dev-only warning. Guarded by `__DEV__` / NODE_ENV.
   * Each unique `key` is warned at most once per process lifetime.
   * Uses console.warn routed through diagnostics so callers never touch console directly.
   */
  private _warned = new Set<string>();

  warnOnce(key: string, message: string): void {
    if (!isBridgeKitDev()) return;
    if (this._warned.has(key)) return;
    this._warned.add(key);
    // eslint-disable-next-line no-console
    console.warn(`[BridgeKit] ${message}`);
  }

  /** Clear warned keys (for test isolation). */
  clearWarnings(): void {
    this._warned.clear();
  }

  reset(): void {
    this._seq = 0;
    this._counters = { calls: 0, errors: 0, firesDropped: 0 };
    this._openStreams = 0;
    this._streamDrops = 0;
    this._warned.clear();
  }
}

export const diagnostics = new DiagnosticsImpl();

/**
 * Enable/disable dev tracing. Default follows __DEV__ / NODE_ENV.
 */
export function setBridgeKitDevTracing(enabled: boolean): void {
  diagnostics.setEnabled(enabled);
}
