declare const __DEV__: boolean | undefined;

interface BridgeKitGlobal {
  readonly process?: {
    readonly env?: {
      readonly NODE_ENV?: string;
    };
  };
}

export function isBridgeKitDev(): boolean {
  try {
    if (typeof __DEV__ === 'boolean') return __DEV__;
  } catch {
    // __DEV__ is only injected by React Native runtimes.
  }

  const nodeEnv = (globalThis as BridgeKitGlobal).process?.env?.NODE_ENV;
  return nodeEnv !== 'production';
}
