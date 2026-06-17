// ---------------------------------------------------------------------------
// Localhost contract — purely JS-provided AND JS-consumed (local-first).
//
// Proves local-first resolution: no native Kotlin counterpart is needed.
// The contract is provided via useLocalhost.useProvide in the same JS runtime
// and resolved locally WITHOUT crossing to the native transport.
// ---------------------------------------------------------------------------

import { Async, defineContract, State, Sync, t } from '@malopezr7/bridgekit/contract';

export const useLocalhost = defineContract('bridgekit.localhost', {
  methods: {
    /** Synchronous: returns the contract's motto — proves Sync resolves locally. */
    getMotto: Sync(t.string()),

    /** Async: returns a greeting for the given name. */
    greet: Async(t.object({ name: t.string() }), t.string()),
  },
  state: {
    /** Reactive mood state, toggled from the UI. Proves local State reactivity. */
    mood: State(t.string(), 'happy'),
  },
});
