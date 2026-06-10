// ---------------------------------------------------------------------------
// React layer — hooks for consuming and providing bridge contracts.
// react-no-use-effect: external-system sync uses dedicated mount-effect pattern.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { BridgeContract } from '../contract/contract';
import type { BridgeScope } from '../contract/protocol';
import type { BridgeCallOpts, BridgeKitJs } from '../runtime/bridgekit';
import { getAmbientScope, setAmbientScope } from '../runtime/bridgekit';
import { getDefaultBridgeKit } from '../runtime/defaultInstance';
import type { MirrorValue } from '../runtime/stateMirror';

// ---- BridgeKit context -----------------------------------------------------

const BridgeKitContext = createContext<BridgeKitJs | null>(null);

function useBridgeKit(): BridgeKitJs {
  return useContext(BridgeKitContext) ?? getDefaultBridgeKit();
}

// ---- BridgeScopeProvider ---------------------------------------------------

interface BridgeScopeProviderProps {
  feature?: string;
  instance?: string;
  children: ReactNode;
}

/**
 * Sets the ambient scope for the subtree.
 * Any useBridge / useProvideBridge calls below inherit this scope.
 */
export function BridgeScopeProvider({
  feature,
  instance,
  children,
}: BridgeScopeProviderProps): ReactNode {
  const scope: BridgeScope = instance
    ? { kind: 'instance', feature, instance }
    : feature
      ? { kind: 'feature', feature }
      : { kind: 'global' };

  // Set ambient scope synchronously during render (no effect needed)
  // NOTE: ambient scope is global module state; for nested scopes use bridgekit context
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — scope fields are the stable deps
  useMemo(() => {
    setAmbientScope(scope);
  }, [scope.kind, scope.feature, scope.instance]);

  return createElement(BridgeKitContext.Provider, { value: getDefaultBridgeKit() }, children);
}

// ---- useBridge -------------------------------------------------------------

/**
 * Returns a stable typed proxy for a contract.
 * The proxy is stable across renders — safe to destructure.
 */
export function useBridge<TShape>(
  contract: BridgeContract<TShape>,
  opts?: { scope?: BridgeScope },
): TShape {
  const bk = useBridgeKit();
  const scope = opts?.scope ?? getAmbientScope();

  // Stable proxy — recreated only if bk/contract/scope identity changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — scope fields are the stable deps
  return useMemo(
    () => bk.bridge(contract, { scope }),
    [bk, contract, scope.kind, scope.feature, scope.instance],
  );
}

// ---- useProvideBridge -------------------------------------------------------

/**
 * Register a contract implementation on mount; close('final') on unmount.
 * StrictMode-safe: double-mount supersedes the first registration harmlessly.
 * Impl captured latest via ref — re-renders don't re-register.
 */
export function useProvideBridge<TShape>(
  contract: BridgeContract<TShape>,
  impl: Partial<TShape>,
  opts?: { scope?: BridgeScope },
): void {
  const bk = useBridgeKit();
  const scope = opts?.scope ?? getAmbientScope();
  const implRef = useRef<Partial<TShape>>(impl);

  // Keep latest impl without re-registering
  useEffect(() => {
    implRef.current = impl;
  });

  // Mount effect: register on mount, close on unmount.
  // This is external-system sync — useEffect is correct here per react-no-use-effect:
  // registration IS a side effect of mounting.
  useMountEffect(() => {
    // Use an indirection impl that always delegates to the latest ref
    const proxyImpl = new Proxy({} as Partial<TShape>, {
      get(_t, prop: string) {
        const current = implRef.current as Record<string, unknown>;
        return current[prop];
      },
    });
    const binding = bk.provide(contract, proxyImpl, { scope });
    return () => {
      binding.close('final');
    };
  });
}

// ---- useBridgeState --------------------------------------------------------

/**
 * Subscribe to a contract's state key.
 * Returns { value, status }.
 */
export function useBridgeState<TShape, K extends string>(
  contract: BridgeContract<TShape>,
  key: K,
  opts?: { scope?: BridgeScope },
): MirrorValue<unknown> {
  const bk = useBridgeKit();
  const scope = opts?.scope ?? getAmbientScope();

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — scope fields are the stable deps
  const mirror = useMemo(
    () => bk.state(contract as BridgeContract<unknown>, key, scope),
    [bk, contract, key, scope.kind, scope.feature, scope.instance],
  );

  return useSyncExternalStore(
    useCallback((onStoreChange) => mirror.subscribe(() => onStoreChange()), [mirror]),
    () => mirror.get(),
    () => mirror.get(),
  );
}

// ---- useBridgeReady --------------------------------------------------------

/**
 * Reactive boolean: true when the contract is provided in the given scope.
 */
export function useBridgeReady<TShape>(
  contract: BridgeContract<TShape>,
  opts?: { scope?: BridgeScope },
): boolean {
  const bk = useBridgeKit();
  const scope = opts?.scope ?? getAmbientScope();

  const [ready, setReady] = useState(() => bk.registry.isProvided(contract.descriptor.id, scope));

  // External system sync: poll/subscribe to registry readiness
  useMountEffect(() => {
    let mounted = true;
    let cancelled = false;

    const check = () => {
      if (!mounted) return;
      const isNow = bk.registry.isProvided(contract.descriptor.id, scope);
      setReady(isNow);
    };

    check();

    // Wait for provision if not yet ready
    if (!bk.registry.isProvided(contract.descriptor.id, scope)) {
      bk.registry
        .whenProvided(contract.descriptor.id, { scope })
        .then(() => {
          if (!cancelled) check();
        })
        .catch(() => {});
    }

    return () => {
      mounted = false;
      cancelled = true;
    };
  });

  return ready;
}

// ---- useMountEffect --------------------------------------------------------

/**
 * Named hook for external-system sync on mount/unmount.
 * Semantically identical to useEffect(fn, []) but named to clarify intent:
 * this is NOT a derived-state effect, it is explicit external-system registration.
 */
function useMountEffect(effect: () => (() => void) | void): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only
  useEffect(effect, []);
}

export type { BridgeCallOpts };
