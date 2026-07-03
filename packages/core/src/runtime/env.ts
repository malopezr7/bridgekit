declare const __DEV__: boolean | undefined;
declare const process:
  | {
      readonly env?: {
        readonly NODE_ENV?: string;
      };
    }
  | undefined;

export function isBridgeKitDev(): boolean {
  if (typeof __DEV__ === 'boolean') return __DEV__;
  if (typeof process !== 'undefined' && typeof process.env !== 'undefined') {
    return process.env.NODE_ENV !== 'production';
  }
  return false;
}
