import type { BridgeContract } from '@malopezr7/bridgekit/contract';
import { defineContract, t } from '@malopezr7/bridgekit/contract';

export const SchemaKindsFixture: BridgeContract<unknown> = defineContract('compile.schema-kinds', {
  methods: {
    getStatus: t.query(t.enum({ Ready: 0, Busy: 1 })),
  },
});
