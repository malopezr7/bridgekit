// ---------------------------------------------------------------------------
// Demo-reverse contract — provided by JS (React Native side), consumed by native.
// Validates ALL four marker directions over the Nitro transport:
//   Async  — native calls JS async method, awaits result
//   Void   — native fires JS method (fire-and-forget)
//   Stream — native collects a JS-provided counter stream
//   State  — native observes a JS-owned status value that updates on a timer
// ---------------------------------------------------------------------------

import { Async, defineContract, State, Stream, t, Void } from '@malopezr7/bridgekit/contract';

export const useDemoReverse = defineContract('bridgekit.demo-reverse', {
  methods: {
    /** Async: native asks JS for a greeting, JS responds. */
    greetFromJs: Async(t.object({ name: t.string() }), t.string()),

    /** Void: native notifies JS of an event (fire-and-forget). JS logs receipt. */
    onNativeEvent: Void(t.object({ type: t.string(), payload: t.optional(t.json()) })),
  },
  streams: {
    /** Stream: JS emits an incrementing counter. Native collects first N values. */
    jsCounter: Stream(t.number()),
  },
  state: {
    /**
     * State: JS owns this value and updates it every ~3s.
     * Native observes the StateFlow and logs each change.
     */
    jsStatus: State(t.string(), 'js-idle'),
  },
});
