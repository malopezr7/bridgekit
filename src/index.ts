// ---------------------------------------------------------------------------
// @malopezr7/bridgekit — main entry point
//
// Slice A: exports the pure contract layer only.
// Slice B will add the runtime (registry, proxies, hooks, loopback transport).
// ---------------------------------------------------------------------------

// Re-export everything from the pure contract layer
export * from './contract';

// TODO(Slice B): export runtime APIs
// export { bridge, provideBridge, useBridge, useProvideBridge, useBridgeState, useBridgeReady } from './runtime';
