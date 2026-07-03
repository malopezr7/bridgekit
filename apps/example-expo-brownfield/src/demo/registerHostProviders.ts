// ---------------------------------------------------------------------------
// registerHostProviders — process-global provider registration.
//
// Imported once at the JS entry point (index.js) after
// '@malopezr7/bridgekit' initialises the singleton. Registers demo.jsinfo so
// native DemoActivity can call getReactNativeVersion / getUserLevel /
// getUserSegments / clockTicks at any time, regardless of which RN screen
// is visible. Also registers demo.local before BridgekitDemo renders, so
// local-first state handles resolve to LocalStateMirror on the first snapshot.
//
// Must NOT be imported inside React components — this is a module-load
// side-effect, not a hook.
// ---------------------------------------------------------------------------

import { getDefaultBridgeKit } from '@malopezr7/bridgekit';
import { useDemoJsinfo } from './contracts/demo-jsinfo.contract';
import { useLocalhost } from './contracts/localhost.contract';
import { jsInfoImpl, localhostImpl } from './providers';

const bk = getDefaultBridgeKit();

// Provide demo.jsinfo globally (native consumes JS).
// The binding lives for the lifetime of the bundle — never closed.
export const jsInfoBinding = bk.provide(useDemoJsinfo, jsInfoImpl);

// Provide demo.local globally before any same-screen consumer snapshot is built.
// This keeps the local State handle local-first instead of accidentally creating
// a transport-backed mirror during the first render.
export const localhostBinding = bk.provide(useLocalhost, localhostImpl);
