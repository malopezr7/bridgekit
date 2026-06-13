// ---------------------------------------------------------------------------
// buildContractHook — creates the Zustand-style ContractHook wrapper for any
// BridgeContract (t.* or marker-style). This is the runtime binding layer.
//
// The hook calls getDefaultBridgeKit() lazily at call time so it has zero
// top-level side effects (purity compatible with §2.3 contract authoring rule).
//
// The hook is a callable function with statics:
//   hook()            → full DerivedConsumer snapshot
//   hook(selector)    → selected slice
//   hook.getState()   → imperative snapshot (non-React, no subscription)
//   hook.scoped(s)    → new hook bound to that scope
//   hook.useProvide() → React provide hook
//   hook.id/hash/descriptor/$descriptor/$contract → codegen statics
// ---------------------------------------------------------------------------

import type { BridgeKitJs } from '../runtime/bridgekit';
import { getDefaultBridgeKit } from '../runtime/defaultInstance';
import type { BridgeContract } from './contract';
import type {
  AnyMarkerT,
  BridgeStreamSource,
  CallOpts,
  ContractHook,
  DerivedConsumer,
  MarkerContractInput,
  ScopeArg,
  StateHandle,
  StateMarkerT,
  StreamMarkerT,
} from './markers';
import type { BridgeScope } from './protocol';

// ---- isMarkerDescriptor ----------------------------------------------------
// A member is marker-style when it has `kind` but NO schema fields
// (params/result/value are all AnySchema nodes — they have their own `kind`).
// Markers are plain { kind } objects or { kind, initial } for state.
// Legacy t.* descriptors carry a `result` or `value` field (also objects with `kind`).
// We detect by the ABSENCE of `result`/`value`/`params` that are AnySchema nodes.

function isMarkerMethodDesc(d: Record<string, unknown>): boolean {
  // Marker: only has `kind` (+ phantom + timeoutMs for Async). No `result`/`params` schema.
  // t.* descriptor: has `result` or `params` that are AnySchema objects.
  return !('result' in d) && !('value' in d);
}

// ---- buildSnapshot ---------------------------------------------------------
// Builds the consumer snapshot for a given bk instance + contract + scope.

function buildSnapshot<T extends MarkerContractInput>(
  bk: BridgeKitJs,
  contract: BridgeContract<unknown>,
  scope: BridgeScope,
): DerivedConsumer<T> {
  // Get the typed proxy for methods + streams (existing bk.bridge() machinery)
  const proxy = bk.bridge(contract, { scope }) as Record<string, unknown>;
  const desc = contract.descriptor;

  // Build state handles — one per state key
  const stateHandles: Record<string, StateHandle<unknown>> = {};
  for (const key of Object.keys(desc.state)) {
    const mirror = bk.state(contract, key, scope);
    stateHandles[key] = {
      get: () => mirror.get().value,
      subscribe: (cb: (v: unknown) => void) => mirror.subscribe((mv) => cb(mv.value)),
    };
  }

  // Build method/stream snapshot from proxy
  const snap: Record<string, unknown> = {};
  for (const key of Object.keys(desc.methods)) {
    snap[key] = proxy[key];
  }
  for (const key of Object.keys(desc.streams)) {
    snap[key] = proxy[key];
  }
  snap.state = stateHandles;

  return snap as unknown as DerivedConsumer<T>;
}

// ---- buildContractHook -----------------------------------------------------

export function buildContractHook<T extends MarkerContractInput>(
  contract: BridgeContract<unknown>,
  scopeOverride?: BridgeScope,
): ContractHook<T> {
  const _getScope = (): BridgeScope => {
    if (scopeOverride) return scopeOverride;
    // Import lazily to avoid circular at module load time
    const { getAmbientScope } =
      require('../runtime/bridgekit') as typeof import('../runtime/bridgekit');
    return getAmbientScope();
  };

  // The hook function — overloaded: no-arg → snapshot, selector → slice
  const hook = ((selector?: (c: DerivedConsumer<T>) => unknown): unknown => {
    const bk = getDefaultBridgeKit();
    const scope = _getScope();
    const snap = buildSnapshot<T>(bk, contract, scope);
    if (selector === undefined) return snap;
    return selector(snap);
  }) as ContractHook<T>;

  // ---- getState (imperative, non-React) ------------------------------------
  Object.defineProperty(hook, 'getState', {
    value: (): DerivedConsumer<T> => {
      const bk = getDefaultBridgeKit();
      const scope = _getScope();
      return buildSnapshot<T>(bk, contract, scope);
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });

  // ---- scoped --------------------------------------------------------------
  Object.defineProperty(hook, 'scoped', {
    value: (scope: ScopeArg | BridgeScope): ContractHook<T> => {
      // Normalise ScopeArg to BridgeScope
      const bridgeScope: BridgeScope =
        'kind' in scope
          ? (scope as BridgeScope)
          : scope.instance
            ? { kind: 'instance', feature: scope.feature, instance: scope.instance }
            : scope.feature
              ? { kind: 'feature', feature: scope.feature }
              : { kind: 'global' };
      return buildContractHook<T>(contract, bridgeScope);
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });

  // ---- useProvide ----------------------------------------------------------
  // Named mount-effect pattern (react-no-use-effect compliant).
  Object.defineProperty(hook, 'useProvide', {
    value: (impl: Partial<DerivedConsumer<T>>): void => {
      // Dynamic import React to keep contract layer pure in non-React environments
      const { useProvideBridge } = require('../react/hooks') as typeof import('../react/hooks');
      const scope = _getScope();
      useProvideBridge(contract as BridgeContract<unknown>, impl as Partial<unknown>, { scope });
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });

  // ---- Codegen statics -----------------------------------------------------
  Object.defineProperty(hook, 'id', {
    value: contract.descriptor.id,
    enumerable: true,
    writable: false,
    configurable: false,
  });

  Object.defineProperty(hook, 'hash', {
    value: contract.hash,
    enumerable: true,
    writable: false,
    configurable: false,
  });

  // The `descriptor` property makes the hook quack as BridgeContract for
  // the existing runtime proxy call sites (bk.bridge(contract)).
  Object.defineProperty(hook, 'descriptor', {
    value: contract.descriptor,
    enumerable: true,
    writable: false,
    configurable: false,
  });

  Object.defineProperty(hook, '$descriptor', {
    value: Object.freeze(contract.descriptor),
    enumerable: false,
    writable: false,
    configurable: false,
  });

  Object.defineProperty(hook, '$contract', {
    value: 'io.github.malopezr7.bridgekit.contract' as const,
    enumerable: true,
    writable: false,
    configurable: false,
  });

  // Make the hook also quack as BridgeContract (for bk.bridge(hook) call sites)
  // The phantom _shape property is never populated at runtime.
  Object.defineProperty(hook, '_shape', {
    value: undefined,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return hook;
}
