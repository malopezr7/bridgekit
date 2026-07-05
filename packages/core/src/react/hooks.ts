// React hooks for consuming and providing bridge contracts.

import type { ReactNode } from 'react';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { BridgeContract } from '../contract/contract';
import type { BridgeScope } from '../contract/protocol';
import type { BridgeCallOpts, BridgeKitJs } from '../runtime/bridgekit';
import { getDefaultBridgeKit } from '../runtime/defaultInstance';
import { diagnostics } from '../runtime/diagnostics';
import type { MirrorValue } from '../runtime/stateMirror';
import { DEFAULT_SCOPE, ScopeContext } from './ScopeContext';

// ---- No-provider warning helper -------------------------------------------

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

function useReadinessSignal(
  bk: BridgeKitJs,
  contract: BridgeContract<unknown>,
  scope: BridgeScope,
): string {
  return useSyncExternalStore(
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — scope fields are the stable deps
    useCallback(
      (onStoreChange) => bk.subscribeReadiness(contract, scope, onStoreChange),
      [bk, contract, scope.kind, scope.feature, scope.instance],
    ),
    () => bk.readinessSnapshot(contract, scope),
    () => bk.readinessSnapshot(contract, scope),
  );
}

// ---- BridgeScopeProvider ---------------------------------------------------

interface BridgeScopeProviderProps {
  feature?: string;
  instance?: string;
  children: ReactNode;
}

interface BridgeKitProviderProps {
  bridgeKit: BridgeKitJs;
  children: ReactNode;
}

/** @internal Test seam for injecting an isolated BridgeKitJs instance. */
export function BridgeKitProvider({ bridgeKit, children }: BridgeKitProviderProps): ReactNode {
  return createElement(BridgeKitContext.Provider, { value: bridgeKit }, children);
}

/**
 * Provides BridgeKit scope for the subtree via React Context.
 * Any useBridge / useProvideBridge / useBridgeState calls below inherit this scope.
 *
 * Nested providers are fully isolated — no cross-talk between sibling subtrees.
 */
export function BridgeScopeProvider({
  feature,
  instance,
  children,
}: BridgeScopeProviderProps): ReactNode {
  const bridgeKit = useBridgeKit();
  const scope: BridgeScope = useMemo(
    () =>
      instance
        ? { kind: 'instance', feature, instance }
        : feature
          ? { kind: 'feature', feature }
          : { kind: 'global' },
    [feature, instance],
  );

  return createElement(
    ScopeContext.Provider,
    { value: scope },
    createElement(BridgeKitContext.Provider, { value: bridgeKit }, children),
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
  useReadinessSignal(bk, contract as BridgeContract<unknown>, scope);

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
 *
 * Effect is keyed by scope identity so switching scope closes the old registration
 * and opens a new one. The impl ref is snapshotted at effect time (post-commit)
 * to avoid exposing a speculative concurrent-render value to bridge callers.
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

  // Update ref during render so it always holds the latest impl.
  // Updating a ref during render is safe — synchronous, no side effects on other
  // components, and avoids the extra render cycle of a no-deps effect.
  implRef.current = impl;

  const scopeKind = scope.kind;
  const scopeFeature = (scope as { feature?: string }).feature;
  const scopeInstance = (scope as { instance?: string }).instance;

  // Keyed by scope identity so a scope change triggers close+re-register.
  // Provider registration is an external-system side effect — useEffect is correct here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — scope fields are the stable deps
  useEffect(() => {
    // Snapshot implRef.current at effect time (post-commit) so the Proxy delegates
    // to the committed impl, not a speculative value from an aborted render.
    const registrationRef = implRef;

    const proxyImpl = new Proxy({} as Partial<TShape>, {
      get(_t, prop: string) {
        const current = registrationRef.current as Record<string, unknown>;
        return current[prop];
      },
    });
    const binding = bk.provide(contract, proxyImpl, { scope });
    return () => {
      binding.close('final');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bk, contract, scopeKind, scopeFeature, scopeInstance]);
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
  const readinessSignal = useReadinessSignal(bk, contract as BridgeContract<unknown>, scope);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — scope fields are the stable deps
  const mirror = useMemo(
    () => bk.state(contract as BridgeContract<unknown>, key, scope),
    [bk, contract, key, scope.kind, scope.feature, scope.instance, readinessSignal],
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
 * Re-evaluates when scope changes; initial state is derived at render time.
 */
export function useBridgeReady<TShape>(
  contract: BridgeContract<TShape>,
  opts?: { scope?: BridgeScope },
): boolean {
  const bk = useBridgeKit();
  const contextScope = useContext(ScopeContext);
  const scope = opts?.scope ?? contextScope;
  useReadinessSignal(bk, contract as BridgeContract<unknown>, scope);

  return bk.isProvided(contract as BridgeContract<unknown>, { scope });
}

export type { BridgeCallOpts };
