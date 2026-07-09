import type { BridgeContract } from '@malopezr7/bridgekit/contract';
import { defineContract, t } from '@malopezr7/bridgekit/contract';

export const CollisionDashFixture: BridgeContract<unknown> = defineContract(
  'compile.collision-name',
  {
    methods: {
      ping: t.query(t.string()),
    },
  },
);

export const CollisionDotFixture: BridgeContract<unknown> = defineContract(
  'compile.collision.name',
  {
    methods: {
      pong: t.query(t.string()),
    },
  },
);
