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
      large: t.state(t.int64(), 9_007_199_254_740_993n),
      initialDate: t.state(t.date(), new Date('2024-03-04T05:06:07.890Z')),
      payload: t.state(t.binary(), new Uint8Array([0, 1, 2, 254, 255])),
      negativeZero: t.state(t.number(), -0),
      positiveZero: t.state(t.number(), 0),
      emptyObject: t.state(t.object({}), {}),
      emptyRecord: t.state(t.record(t.string()), {}),
      emptyArray: t.state(t.array(t.string()), []),
      collections: t.state(
        t.object({
          object: t.object({}),
          record: t.record(t.string()),
          array: t.array(t.string()),
        }),
        { object: {}, record: {}, array: [] },
      ),
      profile: t.state(profileSchema, {
        id: 'initial',
        tags: ['seed'],
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        status: { kind: 'active', since: new Date('2024-01-02T00:00:00.000Z') },
      }),
    },
  },
);
