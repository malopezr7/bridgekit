import type { BridgeContract } from '@malopezr7/bridgekit/contract';
import { defineContract, t } from '@malopezr7/bridgekit/contract';

const profileSchema = t.object({
  id: t.string(),
  tags: t.array(t.string()),
  updatedAt: t.date(),
  status: t.union('kind', {
    active: t.object({ since: t.date() }),
    disabled: t.object({ reason: t.string() }),
  }),
});

export const StateCompoundFixture: BridgeContract<unknown> = defineContract(
  'compile.state-compound',
  {
    state: {
      profile: t.state(profileSchema, {
        id: 'initial',
        tags: ['seed'],
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        status: { kind: 'active', since: new Date('2024-01-02T00:00:00.000Z') },
      }),
    },
  },
);
