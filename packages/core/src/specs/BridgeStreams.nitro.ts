import type { AnyMap, HybridObject } from 'react-native-nitro-modules';

/**
 * BridgeStreams — bidirectional stream channel.
 *
 * Wire rule: stream values are wrapped { v: <value> } by the JS transport;
 * end envelopes carry the full ResultEnvelope shape.
 */
export interface BridgeStreams
  extends HybridObject<{
    ios: 'swift';
    android: 'kotlin';
  }> {
  /**
   * Open a native→JS stream.
   * Returns a streamId (epoch-scoped, opaque string).
   * Callbacks are held until close or epoch end.
   *   - onNext: delivers the next value wrapped as { v: <encoded-value> }
   *   - onEnd:  ResultEnvelope map — { ok: true } or { ok: false, code, message, ... }
   */
  open(env: AnyMap, onNext: (value: AnyMap) => void, onEnd: (end: AnyMap) => void): string;

  /** Cancel a native→JS stream from the JS side. */
  close(streamId: string): void;

  /**
   * Push a value from a JS-provided stream to the Kotlin consumer.
   * Value is wrapped { v: <encoded-value> }.
   * No-op if streamId is unknown or epoch has changed.
   */
  emitFromJs(streamId: string, value: AnyMap): void;

  /**
   * Signal end-of-stream from the JS producer.
   * end is a ResultEnvelope map — { ok: true } or { ok: false, code, message, ... }.
   */
  endFromJs(streamId: string, end: AnyMap): void;
}
