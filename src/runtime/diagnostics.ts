// ---------------------------------------------------------------------------
// Diagnostics — dev-mode structured trace + counters.
// ---------------------------------------------------------------------------

function isDev(): boolean {
  // __DEV__ is injected by Metro/React Native; fallback to NODE_ENV for Node/Jest
  try {
    if (typeof __DEV__ === 'boolean') return __DEV__;
  } catch {
    // ignore ReferenceError in environments where __DEV__ is not defined
  }
  return process.env.NODE_ENV !== 'production';
}

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

// ---- DiagnosticsImpl -------------------------------------------------------

class DiagnosticsImpl {
  private _enabled: boolean = isDev();
  private _seq = 0;
  private _counters: Counters = { calls: 0, errors: 0, firesDropped: 0 };

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

  getCounters(): Counters {
    return { ...this._counters };
  }

  reset(): void {
    this._seq = 0;
    this._counters = { calls: 0, errors: 0, firesDropped: 0 };
  }
}

export const diagnostics = new DiagnosticsImpl();

/**
 * Enable/disable dev tracing. Default follows __DEV__ / NODE_ENV.
 */
export function setBridgeKitDevTracing(enabled: boolean): void {
  diagnostics.setEnabled(enabled);
}
