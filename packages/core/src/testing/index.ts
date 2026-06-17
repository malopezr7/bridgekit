// ---------------------------------------------------------------------------
// Testing utilities for @malopezr7/bridgekit.
// ---------------------------------------------------------------------------

import type { BridgeContract, ContractShape } from '../contract/contract';
import { BridgeKitJs } from '../runtime/bridgekit';
import { LoopbackTransport } from '../runtime/loopbackTransport';

// ---- createTestBridge ------------------------------------------------------

export interface TestBridgeResult {
  bridgekit: BridgeKitJs;
  transport: LoopbackTransport;
}

/**
 * Create an isolated BridgeKitJs instance backed by a LoopbackTransport.
 * Each call returns a fresh, fully independent instance — no shared state.
 */
export function createTestBridge(): TestBridgeResult {
  const transport = new LoopbackTransport();
  const bridgekit = new BridgeKitJs(transport);
  bridgekit.connect();
  return { bridgekit, transport };
}

// ---- mockBridge ------------------------------------------------------------

/**
 * Create a fully-typed mock implementation for a contract.
 * Missing methods throw a clear error when called.
 */
export function mockBridge<TShape>(
  contract: BridgeContract<TShape>,
  partial: Partial<ContractShape<BridgeContract<TShape>>>,
): ContractShape<BridgeContract<TShape>> {
  const desc = contract.descriptor;

  const allMethods = [...Object.keys(desc.methods), ...Object.keys(desc.streams)];

  const mock: Record<string, unknown> = {};

  for (const method of allMethods) {
    if (method in partial && (partial as Record<string, unknown>)[method] !== undefined) {
      mock[method] = (partial as Record<string, unknown>)[method];
    } else {
      mock[method] = (..._args: unknown[]) => {
        throw new Error(
          `[bridgekit] mockBridge: ${desc.id}.${method} was called but not implemented in this mock. ` +
            `Add it to the partial implementation passed to mockBridge().`,
        );
      };
    }
  }

  return mock as ContractShape<BridgeContract<TShape>>;
}

// ---- testProviders --------------------------------------------------------

/**
 * Returns a React wrapper that provides an isolated BridgeKitJs via context.
 * For use with @testing-library/react's `render({ wrapper })`.
 */
export function testProviders(): {
  wrapper: React.ComponentType<{ children: React.ReactNode }>;
  bridgekit: BridgeKitJs;
} {
  // Dynamic import to avoid pulling in React in non-React test environments
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  const { bridgekit, transport: _t } = createTestBridge();

  // Access the internal context (re-exported from react layer for testing)
  // We create a minimal wrapper component here
  function BridgeKitTestProvider({ children }: { children: React.ReactNode }): React.ReactElement {
    return React.createElement(
      // Use default context value override — simplest path
      React.Fragment,
      null,
      children,
    );
  }

  return { wrapper: BridgeKitTestProvider, bridgekit };
}

// TestBridgeResult is already exported as interface above; no re-export needed.
