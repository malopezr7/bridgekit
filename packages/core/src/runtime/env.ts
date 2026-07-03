declare const __DEV__: boolean | undefined;
declare const process: {
  readonly env: {
    readonly NODE_ENV?: string;
  };
};

export function isBridgeKitDev(): boolean {
  if (typeof __DEV__ === 'boolean') return __DEV__;
  try {
    if (typeof process.env.NODE_ENV === 'string') {
      return process.env.NODE_ENV !== 'production';
    }
  } catch {
    // No process global and no bundler substitution - fall through.
  }
  return false;
}
