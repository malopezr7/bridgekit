// ---------------------------------------------------------------------------
// Demo-jsinfo contract — provided by JS (React Native), consumed by NATIVE.
//
// Native DemoActivity will consume this contract to get JS-provided values.
// The clockTicks stream is the JS→native streaming showcase:
// native subscribes, JS emits ~1 value/s.
// ---------------------------------------------------------------------------

import { Async, defineContract, Stream, t } from '@malopezr7/bridgekit/contract';

export const useDemoJsinfo = defineContract('bridgekit.demo-jsinfo', {
  methods: {
    /** Returns the React Native version string (e.g. '0.83.6'). */
    getReactNativeVersion: Async(t.string()),

    /** Returns the current user's level and label. */
    getUserLevel: Async(t.object({ level: t.number(), label: t.string() })),

    /** Returns the current user's segment strings (e.g. ['premium', 'employee']). */
    getUserSegments: Async(t.array(t.string())),
  },
  streams: {
    /**
     * JS emits an incrementing integer ~once per second.
     * Native subscribes to this to demonstrate JS→native streaming.
     */
    clockTicks: Stream(t.number()),
  },
});
