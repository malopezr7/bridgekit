---
title: Wire protocol & errors
description: The call and result envelopes that every operation uses in both directions, and the full error-code taxonomy.
sidebar:
  order: 2
---

Every operation in either direction uses the same two envelopes. There is one wire format,
used symmetrically.

## Call envelope

Sent for every op, both directions:

```jsonc
{
  "op": "invoke | invokeSync | streamOpen | streamClose | stateRead | stateWrite | ...",
  "contractId": "connect.host",
  "member": "installEsim",
  "scope": { "kind": "global | feature | instance", "feature": "...", "instance": "..." },
  "payload": { /* encoded params, declared fields only */ },
  "correlationId": "…",
  "epoch": 7
}
```

## Result envelope

```jsonc
// success
{ "ok": true, "value": /* encoded result */ }

// failure
{
  "ok": false,
  "code": "TIMEOUT",
  "message": "dispatcher connected, contract 'connect.host' not provided in scope feature(Connect)",
  "contractId": "connect.host",
  "member": "installEsim",
  "scope": { "kind": "feature", "feature": "Connect" },
  "readiness": "connected",
  "details": { /* optional */ }
}
```

Every error embeds enough context to state **why** it happened — readiness and provision
context are always present.

## Error codes

| Code | Meaning |
|---|---|
| `CONTRACT_NOT_PROVIDED` | No live binding for `(contract, scope)` after the grace window. |
| `METHOD_NOT_FOUND` | Member absent — carries the member-set diff for skew context. |
| `INCOMPATIBLE_CONTRACT` | Descriptor versions cannot be reconciled. |
| `NOT_PROVIDER` | A non-owning side tried to write state (single-writer enforcement). |
| `TIMEOUT` | Call exceeded its timeout; message states the readiness reason. |
| `CANCELLED` | Caller aborted (`AbortSignal`) or the binding closed mid-call. |
| `PROVIDER_ERROR` | The provider implementation threw. |
| `VALIDATION_FAILED` | Dev-only: payload did not match the schema. |
| `BRIDGE_NOT_READY` | Dispatcher not connected, or a prior-epoch call after teardown. |

## Errors are duck-typed, never `instanceof`

Because BridgeKit is a singleton that can momentarily exist in two copies (dual-bundle edge
cases), errors are matched by a stable `code`, not by class:

```ts
import { isBridgeError } from '@malopezr7/bridgekit';

try {
  await connect.installEsim({ url, iccId });
} catch (e) {
  if (isBridgeError(e, 'TIMEOUT')) retryLater();
  else if (isBridgeError(e, 'CONTRACT_NOT_PROVIDED')) showFallback();
  else throw e;
}
```

The JS dispatcher **never rejects** at the transport level — it catches everything and
resolves `{ ok: false, ... }`. The Kotlin router wraps every native → JS dispatch in
`withTimeout` + try/catch, mapping synchronous throws (dead runtime), never-settling promises
(teardown race), and JS rejections all to envelope codes.

## Transport limits

The AnyMap payloads accept no binary blobs and no nested functions. (Top-level `ArrayBuffer`
params are a future extension.) Encoding always runs and walks **declared fields only**, so
`undefined` and functions in a user object are skipped rather than crashing the converter.
