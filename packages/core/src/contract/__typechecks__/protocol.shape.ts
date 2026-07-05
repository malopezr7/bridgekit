import type { CallEnvelope } from '../protocol';

const streamOpenWithoutDeliveryFlags = {
  op: 'streamOpen',
  contractId: 'protocol.shape.stream',
  member: 'events',
  scope: { kind: 'global' },
  correlationId: 'corr-protocol-shape-without-flags',
  epoch: 1,
} as const satisfies CallEnvelope;

const streamOpenWithDeliveryFlags = {
  op: 'streamOpen',
  contractId: 'protocol.shape.stream',
  member: 'events',
  scope: { kind: 'global' },
  correlationId: 'corr-protocol-shape-with-flags',
  epoch: 1,
  latestOnly: true,
  sticky: true,
} as const satisfies CallEnvelope;

void streamOpenWithoutDeliveryFlags;
void streamOpenWithDeliveryFlags;
