// ---------------------------------------------------------------------------
// ScopeContext — React Context for BridgeKit scope distribution.
//
// Replaces the global mutable ambient scope (setAmbientScope / getAmbientScope)
// so each React subtree holds its own scope without cross-talk.
//
// Usage:
//   - BridgeScopeProvider wraps the subtree with <ScopeContext.Provider value={scope}>
//   - useBridge / useProvideBridge / useBridgeState read scope from useContext(ScopeContext)
//
// react-no-use-effect: scope flows through context during render — no effect needed.
// ---------------------------------------------------------------------------

import { createContext } from 'react';
import type { BridgeScope } from '../contract/protocol';

/**
 * Default scope when no BridgeScopeProvider ancestor is present.
 * Identical to GLOBAL_SCOPE so existing code that omits the provider keeps working.
 * Exported so hooks can compare by reference to detect the no-provider case.
 */
export const DEFAULT_SCOPE: BridgeScope = { kind: 'global' };

/**
 * React Context that carries the current BridgeKit scope for the subtree.
 * Read via useContext(ScopeContext) inside any BridgeKit hook.
 */
export const ScopeContext = createContext<BridgeScope>(DEFAULT_SCOPE);
