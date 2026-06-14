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
  ContractHook,
  DerivedConsumer,
  MarkerContractInput,
  ScopeArg,
  StateHandle,
} from './markers';
import type { BridgeScope } from './protocol';

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
  // hook() IS a React hook (ADR-1): it calls useContext / useMemo / useCallback /
  // useSyncExternalStore UNCONDITIONALLY at the top level. By the hook contract it is
  // only ever called during a React render, so there is no render-detection and no
  // early return — that conditional path was dead on React 19 (the private dispatcher
  // internal it probed does not exist) and broke the Rules-of-Hooks. Subscription is
  // now live: the component re-renders whenever a bound state mirror changes.
  //
  // Imperative (non-React) callers MUST use the separate hook.getState() below, which
  // never calls a React hook.
  //
  // Lazy require for React keeps the contract layer import-pure
  // (purity.web.test.ts bans only static `import … from 'react'`; require is allowed,
  // mirroring the sanctioned lazy require in testing/index.ts).
  const hook = ((selector?: (c: DerivedConsumer<T>) => unknown): unknown => {
    const React = require('react') as typeof import('react');
    const { useCallback, useContext, useMemo, useRef, useSyncExternalStore } = React;
    const { ScopeContext } =
      require('../react/ScopeContext') as typeof import('../react/ScopeContext');

    const bk = getDefaultBridgeKit();

    // Read scope from context; an explicit .scoped() override (scopeOverride) wins.
    const contextScope = useContext(ScopeContext);
    const scope = scopeOverride ?? contextScope;

    // Stable mirrors — recreated only when bk/contract/scope identity changes.
    const mirrors = useMemo(() => {
      const desc = contract.descriptor;
      const result: Record<string, ReturnType<BridgeKitJs['state']>> = {};
      for (const key of Object.keys(desc.state)) {
        result[key] = bk.state(contract, key, scope);
      }
      return result;
    }, [bk, contract, scope.kind, scope.feature, scope.instance]);

    // Stable proxy — recreated only when bk/contract/scope identity changes.
    const proxy = useMemo(
      () => bk.bridge(contract, { scope }) as Record<string, unknown>,
      [bk, contract, scope.kind, scope.feature, scope.instance],
    );

    // Cached snapshot — useSyncExternalStore requires getSnapshot to return a
    // referentially STABLE value until the underlying store actually changes
    // (otherwise it loops: new object every call → re-render → new object …).
    // The cache is invalidated by the subscribe fan-out (a mirror emitted) and by a
    // change in proxy/mirrors identity (scope/contract/bk changed → new closure deps).
    const cacheRef = useRef<{ deps: unknown; dirty: boolean; snap: DerivedConsumer<T> | null }>({
      deps: null,
      dirty: true,
      snap: null,
    });

    // Stable subscribe — fan-out over all state mirrors. Mark the snapshot dirty
    // before notifying so the next getSnapshot rebuilds from fresh mirror values.
    const subscribe = useCallback(
      (onStoreChange: () => void): (() => void) => {
        const unsubs = Object.values(mirrors).map((mirror) =>
          mirror.subscribe(() => {
            cacheRef.current.dirty = true;
            onStoreChange();
          }),
        );
        return () => {
          for (const unsub of unsubs) unsub();
        };
      },
      [mirrors],
    );

    // Build (and cache) the snapshot from the current mirror values.
    const getSnapshot = useCallback((): DerivedConsumer<T> => {
      const cache = cacheRef.current;
      // Rebuild on first call, when a mirror emitted (dirty), or when the closure
      // deps (proxy/mirrors) changed identity — otherwise return the cached object.
      const depsKey = { proxy, mirrors };
      const depsChanged =
        cache.deps === null ||
        (cache.deps as { proxy: unknown; mirrors: unknown }).proxy !== proxy ||
        (cache.deps as { proxy: unknown; mirrors: unknown }).mirrors !== mirrors;
      if (cache.snap !== null && !cache.dirty && !depsChanged) {
        return cache.snap;
      }

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

      const built = snap as unknown as DerivedConsumer<T>;
      cache.snap = built;
      cache.deps = depsKey;
      cache.dirty = false;
      return built;
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
      // useProvideBridge reads scope from ScopeContext internally (ADR-2). Pass the
      // override ONLY when .scoped() set it; otherwise pass none so useProvideBridge
      // honours the ScopeContext scope instead of being force-fed the global fallback.
      const { useProvideBridge } = require('../react/hooks') as typeof import('../react/hooks');
      const opts = scopeOverride ? { scope: scopeOverride } : undefined;
      useProvideBridge(contract as BridgeContract<unknown>, impl as Partial<unknown>, opts);
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
