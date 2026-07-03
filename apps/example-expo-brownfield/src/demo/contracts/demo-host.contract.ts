// ---------------------------------------------------------------------------
// Demo-host contract — provided by NATIVE (Android/iOS), consumed by JS.
//
// Covers:
//   ping        — Async round-trip (JS sends message, native replies)
//   increment   — Async mutation (native bumps counter state)
//   ticker      — Stream<number> native emits ~1 value/s
//   counter     — State<number> observable, mutated via increment()
//   say         — Void (JS sends text to native fire-and-forget)
//   echoes      — Stream<string> native transforms + echoes text back (bidirectional showcase)
// ---------------------------------------------------------------------------

import { Async, defineContract, State, Stream, t, Void } from '@malopezr7/bridgekit/contract';

export const useDemoHost = defineContract('bridgekit.demo-host', {
  methods: {
    /** Async query: JS sends a message, native replies with pong + server epoch. */
    ping: Async(
      t.object({ message: t.string() }),
      t.object({ reply: t.string(), epoch: t.number() }),
    ),

    /** Async mutation: native increments the shared counter by 1. */
    increment: Async(t.number()),

    /** Fire-and-forget: JS sends text to native for echo processing. */
    say: Void(t.object({ text: t.string() })),
  },
  streams: {
    /** Native emits an incrementing integer ~once per second. */
    ticker: Stream(t.number()),

    /** Native echoes back received 'say' payloads (uppercased). Bidirectional showcase. */
    echoes: Stream(t.string()),
  },
  state: {
    /** Shared counter. Initial value 0. Mutated via increment(). */
    counter: State(t.number(), 0),
  },
});
