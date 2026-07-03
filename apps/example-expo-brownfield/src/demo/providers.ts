// ---------------------------------------------------------------------------
// JS-side implementations for contracts that JS PROVIDES.
//
// These must be registered at mount time so native can consume them as soon
// as the JS dispatcher connects. The BRIDGE_NOT_READY timeout is 10 s, so
// registration must happen before native attempts to consume.
//
// Exports:
//   jsInfoImpl     — impl for demo.jsinfo (consumed by native DemoActivity)
//   localhostImpl  — impl for demo.local  (pure JS, local-first)
//   demoReverseImpl — impl for demo.reverse (all four markers, consumed by native)
// ---------------------------------------------------------------------------

import { streamSource } from '@malopezr7/bridgekit';

// ---------------------------------------------------------------------------
// demo.jsinfo — bridgekit equivalent of native module calls in DemoActivity
// ---------------------------------------------------------------------------

// Real RN version: read from the package.json. Falls back to a constant if
// the module resolution fails (e.g. in unit tests / web builds).
const RN_VERSION: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('react-native/package.json') as { version: string }).version;
  } catch {
    return '0.83.6';
  }
})();

export const jsInfoImpl = {
  getReactNativeVersion: (): Promise<string> => Promise.resolve(RN_VERSION),

  getUserLevel: (): Promise<{ level: number; label: string }> =>
    Promise.resolve({ level: 3, label: 'Senior Engineer' }),

  getUserSegments: (): Promise<string[]> => Promise.resolve(['employee', 'premium', 'beta-tester']),

  /** JS emits an incrementing tick every second. Native subscribes. */
  clockTicks: (): ReturnType<typeof streamSource<number>> =>
    streamSource<number>((emit, _end) => {
      let tick = 0;
      const iv = setInterval(() => {
        emit(tick);
        tick += 1;
      }, 1000);
      return () => clearInterval(iv);
    }),
};

// ---------------------------------------------------------------------------
// demo.local — pure JS, local-first (no native cross)
// ---------------------------------------------------------------------------

export const localhostImpl = {
  getMotto: (): string => 'Bridge the gap. Own the contract.',

  greet: async ({ name }: { name: string }): Promise<string> =>
    `Hello, ${name}! Resolved entirely in JS.`,

  // mood state is owned by the screen via Binding.setState — no impl needed here
};

// ---------------------------------------------------------------------------
// demo.reverse — all four markers, JS provides, native consumes
// ---------------------------------------------------------------------------

export const demoReverseImpl = {
  greetFromJs: ({ name }: { name: string }): Promise<string> =>
    Promise.resolve(`Hi ${name}, from JS reverse provider!`),

  onNativeEvent: ({ type, payload }: { type: string; payload?: unknown }): void => {
    console.log(`[BridgeKit] Void received: type=${type} payload=${JSON.stringify(payload)}`);
  },

  jsCounter: (): ReturnType<typeof streamSource<number>> =>
    streamSource<number>((emit, end) => {
      let tick = 0;
      const iv = setInterval(() => {
        emit(tick);
        tick += 1;
        if (tick >= 20) {
          clearInterval(iv);
          end();
        }
      }, 500);
      return () => clearInterval(iv);
    }),
};
