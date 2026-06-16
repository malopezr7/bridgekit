// buildContractHook — creates the ContractHook wrapper for any BridgeContract.
// Callable as a React hook (full snapshot) or hook(selector) for a slice.
// Statics: getState(), scoped(), useProvide(), id, hash, descriptor, $descriptor, $contract.

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

function buildSnapshot<T extends MarkerContractInput>(
  bk: BridgeKitJs,
  contract: BridgeContract<unknown>,
  scope: BridgeScope,
): DerivedConsumer<T> {
  const proxy = bk.bridge(contract, { scope }) as Record<string, unknown>;
  const desc = contract.descriptor;

  const stateHandles: Record<string, StateHandle<unknown>> = {};
  for (const key of Object.keys(desc.state)) {
    const mirror = bk.state(contract, key, scope);
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
}

export function buildContractHook<T extends MarkerContractInput>(
  contract: BridgeContract<unknown>,
  scopeOverride?: BridgeScope,
): ContractHook<T> {
  // Falls back to getAmbientScope() for non-React callers (getState, useProvide).
  const _getScopeImperative = (): BridgeScope => {
    if (scopeOverride) return scopeOverride;
    // Import lazily to avoid circular at module load time
    const { getAmbientScope } =
      require('../runtime/bridgekit') as typeof import('../runtime/bridgekit');
    return getAmbientScope();
  };

  // hook() IS a React hook: calls useContext/useMemo/useCallback/useSyncExternalStore
  // unconditionally. Imperative callers must use hook.getState() instead.
  // Lazy require for React keeps the contract layer import-pure.
  const hook = ((selector?: (c: DerivedConsumer<T>) => unknown): unknown => {
    const React = require('react') as typeof import('react');
    const { useCallback, useContext, useMemo, useRef, useSyncExternalStore } = React;
    const { ScopeContext } =
      require('../react/ScopeContext') as typeof import('../react/ScopeContext');

    const bk = getDefaultBridgeKit();

    const contextScope = useContext(ScopeContext);
    const scope = scopeOverride ?? contextScope;

    const mirrors = useMemo(() => {
      const desc = contract.descriptor;
      const result: Record<string, ReturnType<BridgeKitJs['state']>> = {};
      for (const key of Object.keys(desc.state)) {
        result[key] = bk.state(contract, key, scope);
      }
      return result;
    }, [bk, contract, scope.kind, scope.feature, scope.instance]);

    const proxy = useMemo(
      () => bk.bridge(contract, { scope }) as Record<string, unknown>,
      [bk, contract, scope.kind, scope.feature, scope.instance],
    );

    // useSyncExternalStore requires getSnapshot to return a referentially stable value
    // until the store changes (new object every call would loop). Cache is invalidated
    // when a mirror emits or when proxy/mirrors identity changes.
    const cacheRef = useRef<{ deps: unknown; dirty: boolean; snap: DerivedConsumer<T> | null }>({
      deps: null,
      dirty: true,
      snap: null,
    });

    // Fan-out over all state mirrors; mark dirty before notifying so getSnapshot rebuilds.
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

    const getSnapshot = useCallback((): DerivedConsumer<T> => {
      const cache = cacheRef.current;
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
  Object.defineProperty(hook, 'useProvide', {
    value: (impl: Partial<DerivedConsumer<T>>): void => {
      // Dynamic import keeps contract layer pure in non-React environments.
      // Pass scopeOverride only when .scoped() set it; otherwise let useProvideBridge
      // honour the ScopeContext scope.
      const { useProvideBridge } = require('../react/hooks') as typeof import('../react/hooks');
      const opts = scopeOverride ? { scope: scopeOverride } : undefined;
      useProvideBridge(contract as BridgeContract<unknown>, impl as Partial<unknown>, opts);
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });

  // ---- Codegen statics ---------------------------------------------------
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

  // Makes the hook quack as BridgeContract for bk.bridge(contract) call sites.
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

  // Phantom type only — never populated at runtime.
  Object.defineProperty(hook, '_shape', {
    value: undefined,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return hook;
}
