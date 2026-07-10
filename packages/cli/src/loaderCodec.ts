import { CliError } from './cliError.js';

/** Maximum UTF-8 size of the private fd-3 loader payload. Contract descriptors are normally KiB. */
export const MAX_LOADER_PAYLOAD_BYTES = 1024 * 1024;
/** Maximum recursive value depth, measured from each token root. */
export const MAX_LOADER_NESTING_DEPTH = 64;
/** Maximum tagged value nodes per payload; 10k leaves ample headroom for KiB-scale CLI contracts. */
export const MAX_LOADER_NODE_COUNT = 10_000;
/** spawnSync pipe budget; deliberately larger than the supported fd-3 payload. */
export const MAX_LOADER_SPAWN_BUFFER_BYTES = 2 * MAX_LOADER_PAYLOAD_BYTES;

type LoaderNode =
  | { t: 'u' }
  | { t: 'n' }
  | { t: 'b'; v: boolean }
  | { t: 's'; v: string }
  | { t: 'd'; v: number }
  | { t: 'nz' }
  | { t: 'bi'; v: string }
  | { t: 'date'; v: number }
  | { t: 'u8'; v: string }
  | { t: 'ab'; v: string }
  | { t: 'a'; v: LoaderNode[] }
  | { t: 'o'; v: Array<[string, LoaderNode]> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function valueKind(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const ctor = value.constructor;
  if (ctor === undefined) return 'object';
  return ctor.name || 'object';
}

function encodeNode(
  value: unknown,
  ancestors: Set<object>,
  path: string,
  depth: number,
  nodeCount: { value: number },
): LoaderNode {
  if (depth > MAX_LOADER_NESTING_DEPTH) {
    throw new Error(`Loader value nesting depth exceeds ${MAX_LOADER_NESTING_DEPTH} at ${path}`);
  }
  nodeCount.value += 1;
  if (nodeCount.value > MAX_LOADER_NODE_COUNT) {
    throw new Error(`Loader value node count exceeds ${MAX_LOADER_NODE_COUNT} at ${path}`);
  }
  if (value === undefined) return { t: 'u' };
  if (value === null) return { t: 'n' };
  if (typeof value === 'boolean') return { t: 'b', v: value };
  if (typeof value === 'string') return { t: 's', v: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${path}`);
    if (Object.is(value, -0)) return { t: 'nz' };
    return { t: 'd', v: value };
  }
  if (typeof value === 'bigint') return { t: 'bi', v: value.toString() };
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`Unsupported ${typeof value} at ${path}`);
  }
  if (typeof value !== 'object') throw new Error(`Unsupported ${typeof value} at ${path}`);

  if (ancestors.has(value)) throw new Error(`Cycle detected at ${path}`);
  ancestors.add(value);
  try {
    if (value instanceof Date) {
      const epochMs = value.getTime();
      if (!Number.isFinite(epochMs)) throw new Error(`Invalid Date at ${path}`);
      return { t: 'date', v: epochMs };
    }
    if (value instanceof Uint8Array) {
      return { t: 'u8', v: Buffer.from(value).toString('base64') };
    }
    if (value instanceof ArrayBuffer) {
      return { t: 'ab', v: Buffer.from(value).toString('base64') };
    }
    if (Array.isArray(value)) {
      const items: LoaderNode[] = [];
      for (let index = 0; index < value.length; index++) {
        items.push(encodeNode(value[index], ancestors, `${path}[${index}]`, depth + 1, nodeCount));
      }
      return { t: 'a', v: items };
    }
    if (!isPlainObject(value)) {
      throw new Error(`Unsupported ${valueKind(value)} at ${path}`);
    }

    const symbolKey = Reflect.ownKeys(value).find((key) => typeof key === 'symbol');
    if (symbolKey !== undefined) throw new Error(`Unsupported symbol key at ${path}`);
    const entries: Array<[string, LoaderNode]> = [];
    for (const key of Object.keys(value)) {
      entries.push([
        key,
        encodeNode(value[key], ancestors, `${path}.${key}`, depth + 1, nodeCount),
      ]);
    }
    return { t: 'o', v: entries };
  } finally {
    ancestors.delete(value);
  }
}

function encodeLoaderPayloadForWorker(tokens: unknown[]): string {
  const encodedTokens: LoaderNode[] = [];
  const nodeCount = { value: 0 };
  for (let index = 0; index < tokens.length; index++) {
    encodedTokens.push(encodeNode(tokens[index], new Set(), `tokens[${index}]`, 0, nodeCount));
  }
  const payload = JSON.stringify({
    $bridgekitLoader: 'v1',
    tokens: encodedTokens,
  });
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_LOADER_PAYLOAD_BYTES) {
    throw new Error(
      `Loader payload exceeds ${MAX_LOADER_PAYLOAD_BYTES} bytes (received ${payloadBytes})`,
    );
  }
  return payload;
}

export function encodeLoaderPayload(tokens: unknown[]): string {
  try {
    return encodeLoaderPayloadForWorker(tokens);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Contract loader cannot encode value: ${message}`);
  }
}

export function loaderEncoderWorkerSource(): string {
  // This transport belongs to the CLI loader, not the schema-dependent core wire codec.
  // Keep every dependency in this list: functions are stringified into an ESM worker and
  // may use only embedded declarations plus Node globals (notably Buffer).
  return [
    `const MAX_LOADER_PAYLOAD_BYTES = ${MAX_LOADER_PAYLOAD_BYTES};`,
    `const MAX_LOADER_NESTING_DEPTH = ${MAX_LOADER_NESTING_DEPTH};`,
    `const MAX_LOADER_NODE_COUNT = ${MAX_LOADER_NODE_COUNT};`,
    isPlainObject,
    valueKind,
    encodeNode,
    encodeLoaderPayloadForWorker,
  ]
    .map((fn) => fn.toString())
    .join('\n');
}

function assertNodeShape(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value))
    throw new CliError(`Malformed loader node at ${path}: expected object`);
  const keys = Object.keys(value);
  const missing = allowedKeys.filter((key) => !keys.includes(key));
  if (missing.length > 0) {
    const noun = missing.length === 1 ? 'field' : 'fields';
    throw new CliError(`Malformed loader node at ${path}: missing ${noun} ${missing.join(', ')}`);
  }
  const extra = keys.filter((key) => !allowedKeys.includes(key));
  if (extra.length > 0) {
    const noun = extra.length === 1 ? 'field' : 'fields';
    throw new CliError(`Malformed loader node at ${path}: unexpected ${noun} ${extra.join(', ')}`);
  }
}

function isCanonicalBase64(value: string): boolean {
  if (value === '') return true;
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function decodeNode(
  value: unknown,
  path: string,
  depth: number,
  nodeCount: { value: number },
): unknown {
  if (depth > MAX_LOADER_NESTING_DEPTH) {
    throw new CliError(`Loader value nesting depth exceeds ${MAX_LOADER_NESTING_DEPTH} at ${path}`);
  }
  nodeCount.value += 1;
  if (nodeCount.value > MAX_LOADER_NODE_COUNT) {
    throw new CliError(`Loader value node count exceeds ${MAX_LOADER_NODE_COUNT} at ${path}`);
  }
  if (!isPlainObject(value) || typeof value.t !== 'string') {
    throw new CliError(`Malformed loader node at ${path}: missing string tag`);
  }

  switch (value.t) {
    case 'u':
      assertNodeShape(value, ['t'], path);
      return undefined;
    case 'n':
      assertNodeShape(value, ['t'], path);
      return null;
    case 'b':
      assertNodeShape(value, ['t', 'v'], path);
      if (typeof value.v !== 'boolean') throw new CliError(`Malformed boolean at ${path}`);
      return value.v;
    case 's':
      assertNodeShape(value, ['t', 'v'], path);
      if (typeof value.v !== 'string') throw new CliError(`Malformed string at ${path}`);
      return value.v;
    case 'd':
      assertNodeShape(value, ['t', 'v'], path);
      if (typeof value.v !== 'number' || !Number.isFinite(value.v)) {
        throw new CliError(`Malformed number at ${path}`);
      }
      return value.v;
    case 'nz':
      assertNodeShape(value, ['t'], path);
      return -0;
    case 'bi':
      assertNodeShape(value, ['t', 'v'], path);
      if (typeof value.v !== 'string' || value.v === '-0' || !/^-?(?:0|[1-9]\d*)$/.test(value.v)) {
        throw new CliError(`Malformed BigInt '${String(value.v)}' at ${path}`);
      }
      return BigInt(value.v);
    case 'date': {
      assertNodeShape(value, ['t', 'v'], path);
      if (typeof value.v !== 'number' || !Number.isInteger(value.v)) {
        throw new CliError(`Invalid Date epoch milliseconds at ${path}`);
      }
      const date = new Date(value.v);
      if (!Number.isFinite(date.getTime())) throw new CliError(`Invalid Date at ${path}`);
      return date;
    }
    case 'u8':
      assertNodeShape(value, ['t', 'v'], path);
      if (typeof value.v !== 'string' || !isCanonicalBase64(value.v)) {
        throw new CliError(`Invalid base64 at ${path}`);
      }
      return new Uint8Array(Buffer.from(value.v, 'base64'));
    case 'ab': {
      assertNodeShape(value, ['t', 'v'], path);
      if (typeof value.v !== 'string' || !isCanonicalBase64(value.v)) {
        throw new CliError(`Invalid base64 at ${path}`);
      }
      const bytes = new Uint8Array(Buffer.from(value.v, 'base64'));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    case 'a':
      assertNodeShape(value, ['t', 'v'], path);
      if (!Array.isArray(value.v)) throw new CliError(`Malformed array at ${path}`);
      return value.v.map((item, index) =>
        decodeNode(item, `${path}[${index}]`, depth + 1, nodeCount),
      );
    case 'o': {
      assertNodeShape(value, ['t', 'v'], path);
      if (!Array.isArray(value.v)) throw new CliError(`Malformed object at ${path}`);
      const result: Record<string, unknown> = {};
      const seen = new Set<string>();
      for (let index = 0; index < value.v.length; index++) {
        const pair = value.v[index];
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') {
          throw new CliError(`Malformed object entry at ${path}[${index}]`);
        }
        const key = pair[0];
        if (seen.has(key)) throw new CliError(`Duplicate object key '${key}' at ${path}`);
        seen.add(key);
        Object.defineProperty(result, key, {
          value: decodeNode(pair[1], `${path}.${key}`, depth + 1, nodeCount),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }
    default:
      throw new CliError(`Unknown loader node tag '${value.t}' at ${path}`);
  }
}

export function decodeLoaderPayload(payload: string): unknown[] {
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_LOADER_PAYLOAD_BYTES) {
    throw new CliError(
      `Contract loader payload exceeds ${MAX_LOADER_PAYLOAD_BYTES} bytes (received ${payloadBytes})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new CliError(`Contract loader returned invalid JSON: ${payload.substring(0, 200)}`);
  }
  if (!isPlainObject(parsed) || parsed.$bridgekitLoader !== 'v1') {
    const version = isPlainObject(parsed) ? String(parsed.$bridgekitLoader) : valueKind(parsed);
    throw new CliError(`Unsupported contract loader payload version: ${version}`);
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes('$bridgekitLoader') || !keys.includes('tokens')) {
    throw new CliError('Malformed contract loader payload envelope');
  }
  if (!Array.isArray(parsed.tokens)) throw new CliError('Malformed contract loader token list');
  const nodeCount = { value: 0 };
  return parsed.tokens.map((token, index) => decodeNode(token, `tokens[${index}]`, 0, nodeCount));
}
