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
import { getDefaultBridgeKit } from '../runtime/defaultInstance';
import { diagnostics } from '../runtime/diagnostics';
import type { MirrorValue } from '../runtime/stateMirror';
import { DEFAULT_SCOPE, ScopeContext } from './ScopeContext';

// ---- No-provider warning helper -----------------------------------------------

/**
 * Emits a ONE-TIME dev-only warning when a scoped hook runs without a
 * BridgeScopeProvider ancestor in the tree.
 *
 * Detection: the context value is identity-equal to DEFAULT_SCOPE (the createContext
 * default) AND the caller did not pass an explicit scope override via opts?.scope.
 *
 * @param contextScope  Value returned by useContext(ScopeContext)
 * @param hasExplicitScope  true when opts?.scope was provided by the caller
 * @param hookName  Hook name for the warning message
 */
function useWarnIfNoProvider(
  contextScope: BridgeScope,
  hasExplicitScope: boolean,
  hookName: string,
): void {
  const isDefault = contextScope === DEFAULT_SCOPE;
  // Stable key per hook+call-site: use the hook name; a ref ensures one warn per mount.
  const warnedRef = useRef(false);
  if (!warnedRef.current && isDefault && !hasExplicitScope) {
    warnedRef.current = true;
    diagnostics.warnOnce(
      `no-provider:${hookName}`,
      `${hookName} was called without a BridgeScopeProvider ancestor. ` +
        'Falling back to global scope. ' +
        'Wrap your component tree with <BridgeScopeProvider> to use isolated scopes.',
    );
  }
}

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
 * Provides BridgeKit scope for the subtree via React Context.
 * Any useBridge / useProvideBridge / useBridgeState calls below inherit this scope.
 *
 * Nested providers are fully isolated — no cross-talk between sibling subtrees.
 * react-no-use-effect: scope flows through context (derived during render, no effect).
 */
export function BridgeScopeProvider({
  feature,
  instance,
  children,
}: BridgeScopeProviderProps): ReactNode {
  // Memoize the scope object so Provider value reference is stable across renders
  // when feature/instance strings haven't changed.
  const scope: BridgeScope = useMemo(
    () =>
      instance
        ? { kind: 'instance', feature, instance }
        : feature
          ? { kind: 'feature', feature }
          : { kind: 'global' },
    [feature, instance],
  );

  // Wrap children in both contexts: ScopeContext (scope) + BridgeKitContext (bk instance).
  return createElement(
    ScopeContext.Provider,
    { value: scope },
    createElement(BridgeKitContext.Provider, { value: getDefaultBridgeKit() }, children),
  );
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
  const contextScope = useContext(ScopeContext);
  const scope = opts?.scope ?? contextScope;
  useWarnIfNoProvider(contextScope, opts?.scope !== undefined, 'useBridge');

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
  const contextScope = useContext(ScopeContext);
  const scope = opts?.scope ?? contextScope;
  useWarnIfNoProvider(contextScope, opts?.scope !== undefined, 'useProvideBridge');

  const implRef = useRef<Partial<TShape>>(impl);

  // S-2 fix (react-no-use-effect): update ref during render, not in a bare useEffect.
  // The ref always holds the latest impl; the Proxy in useMountEffect delegates to it.
  // Updating a ref during render is safe — it is synchronous, has no observable side
  // effects on other components, and avoids the extra render cycle of a no-deps effect.
  implRef.current = impl;

  // Mount effect: register on mount, close on unmount.
  // This is external-system sync — useMountEffect is correct here per react-no-use-effect:
  // provider registration IS a side effect of mounting into the bridge runtime.
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
  const contextScope = useContext(ScopeContext);
  const scope = opts?.scope ?? contextScope;
  useWarnIfNoProvider(contextScope, opts?.scope !== undefined, 'useBridgeState');

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
 *
 * H-12: re-evaluates when scope changes by keying the effect on scope identity fields.
 * Initial state is derived at render time per the CURRENT scope (not captured at mount).
 */
export function useBridgeReady<TShape>(
  contract: BridgeContract<TShape>,
  opts?: { scope?: BridgeScope },
): boolean {
  const bk = useBridgeKit();
  const contextScope = useContext(ScopeContext);
  const scope = opts?.scope ?? contextScope;

  // H-12: derive initial readiness per current scope at render time.
  // We need to re-derive when scope changes; useState lazy init only runs once,
  // so we read synchronously during render and update via the effect when scope changes.
  const contractId = contract.descriptor.id;
  const scopeKind = scope.kind;
  const scopeFeature = (scope as { feature?: string }).feature;
  const scopeInstance = (scope as { instance?: string }).instance;

  const [ready, setReady] = useState(() => bk.registry.isProvided(contractId, scope));

  // H-12: effect re-runs on scope identity change, re-deriving readiness for the new scope.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — scope fields are the stable deps
  useEffect(() => {
    let cancelled = false;

    // Immediately snapshot current readiness for new scope
    setReady(bk.registry.isProvided(contractId, scope));

    // Wait for provision if not yet ready
    if (!bk.registry.isProvided(contractId, scope)) {
      bk.registry
        .whenProvided(contractId, { scope })
        .then(() => {
          if (!cancelled) setReady(bk.registry.isProvided(contractId, scope));
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bk, contractId, scopeKind, scopeFeature, scopeInstance]);

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
