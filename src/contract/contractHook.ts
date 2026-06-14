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
  // Imperative scope resolver — used by getState() and useProvide() which may run
  // outside a React render. Falls back to getAmbientScope() for non-React callers.
  const _getScopeImperative = (): BridgeScope => {
    if (scopeOverride) return scopeOverride;
    // Import lazily to avoid circular at module load time
    const { getAmbientScope } =
      require('../runtime/bridgekit') as typeof import('../runtime/bridgekit');
    return getAmbientScope();
  };

  // The hook function — overloaded: no-arg → snapshot, selector → slice.
  //
  // When called INSIDE a React render (the primary path), uses useSyncExternalStore
  // to subscribe to all state mirrors so the component re-renders on changes (W4-2),
  // and reads scope from ScopeContext instead of global state (W4-1).
  //
  // When called OUTSIDE a React render (imperative callers, legacy tests), falls back
  // to the non-subscribing buildSnapshot path — same behavior as before W4.
  //
  // Lazy require for React hooks to keep the contract layer import-pure
  // (the purity test forbids static 'react' imports in src/contract/).
  const hook = ((selector?: (c: DerivedConsumer<T>) => unknown): unknown => {
    // Lazy-require React internals to preserve module-level purity.
    // Accessing __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
    // lets us detect whether we are inside a React render without throwing.
    const React = require('react') as typeof import('react');
    const dispatcher = (React as Record<string, unknown>)[
      '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED'
    ] as Record<string, unknown> | undefined;
    const isInReactRender =
      dispatcher !== undefined &&
      (dispatcher.ReactCurrentDispatcher as Record<string, unknown> | undefined)?.current !== null;

    const bk = getDefaultBridgeKit();

    if (!isInReactRender) {
      // Imperative / non-React path — simple snapshot, no subscription.
      const scope = _getScopeImperative();
      const snap = buildSnapshot<T>(bk, contract, scope);
      if (selector === undefined) return snap;
      return selector(snap);
    }

    // --- React render path (W4-1 + W4-2) ---
    const { useCallback, useContext, useMemo, useSyncExternalStore } = React;
    const { ScopeContext } =
      require('../react/ScopeContext') as typeof import('../react/ScopeContext');

    // Read from context when called as a React hook (scopeOverride may still override)
    const contextScope = useContext(ScopeContext);
    const scope = scopeOverride ?? contextScope;

    // Stable mirrors — recreated only when bk/contract/scope identity changes.
    // biome-ignore lint/correctness/useExhaustiveDependencies: scope fields are the stable deps
    const mirrors = useMemo(() => {
      const desc = contract.descriptor;
      const result: Record<string, ReturnType<BridgeKitJs['state']>> = {};
      for (const key of Object.keys(desc.state)) {
        result[key] = bk.state(contract, key, scope);
      }
      return result;
    }, [bk, contract, scope.kind, scope.feature, scope.instance]);

    // Stable proxy — recreated only when bk/contract/scope identity changes.
    // biome-ignore lint/correctness/useExhaustiveDependencies: scope fields are the stable deps
    const proxy = useMemo(
      () => bk.bridge(contract, { scope }) as Record<string, unknown>,
      [bk, contract, scope.kind, scope.feature, scope.instance],
    );

    // Stable subscribe — fan-out over all state mirrors.
    const subscribe = useCallback(
      (onStoreChange: () => void): (() => void) => {
        const unsubs = Object.values(mirrors).map((mirror) =>
          mirror.subscribe(() => onStoreChange()),
        );
        return () => {
          for (const unsub of unsubs) unsub();
        };
      },
      [mirrors],
    );

    // Build snapshot from the current mirror values (called by useSyncExternalStore).
    const getSnapshot = useCallback((): DerivedConsumer<T> => {
      const desc = contract.descriptor;
      const stateHandles: Record<string, StateHandle<unknown>> = {};
      for (const key of Object.keys(desc.state)) {
        const mirror = mirrors[key];
        if (!mirror) continue;
        stateHandles[key] = {
          get: () => mirror.get().value,
          subscribe: (cb: (v: unknown) => void) => mirror.subscribe((mv) => cb(mv.value)),
        };
      }

      const snap: Record<string, unknown> = {};
      for (const key of Object.keys(desc.methods)) {
        snap[key] = proxy[key];
      }
      for (const key of Object.keys(desc.streams)) {
        snap[key] = proxy[key];
      }
      snap.state = stateHandles;

      return snap as unknown as DerivedConsumer<T>;
    }, [proxy, mirrors]);

    const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    if (selector === undefined) return snap;
    return selector(snap);
  }) as ContractHook<T>;

  // ---- getState (imperative, non-React) ------------------------------------
  Object.defineProperty(hook, 'getState', {
    value: (): DerivedConsumer<T> => {
      const bk = getDefaultBridgeKit();
      const scope = _getScopeImperative();
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
      // Dynamic import React to keep contract layer pure in non-React environments.
      // useProvideBridge reads scope from ScopeContext internally (W4-1), so we
      // pass the scopeOverride only when explicitly set via .scoped().
      const { useProvideBridge } = require('../react/hooks') as typeof import('../react/hooks');
      const scope = _getScopeImperative();
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
