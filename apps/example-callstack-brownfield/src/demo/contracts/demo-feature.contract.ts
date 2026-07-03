// ---------------------------------------------------------------------------
// Demo-feature contract — provided by JS (React Native side).
// Validates: native → JS typed query direction.
// ---------------------------------------------------------------------------

import { Async, defineContract, t } from '@malopezr7/bridgekit/contract';

export const useDemoFeature = defineContract('bridgekit.demo-feature', {
  methods: {
    /** Returns a greeting string for the given name. */
    getGreeting: Async(t.object({ name: t.string() }), t.string()),
  },
});
