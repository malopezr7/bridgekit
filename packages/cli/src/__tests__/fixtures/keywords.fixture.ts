import type { BridgeContract } from '@malopezr7/bridgekit/contract';
import { defineContract, t } from '@malopezr7/bridgekit/contract';

export const KeywordsFixture: BridgeContract<unknown> = defineContract('compile.keywords', {
  methods: {
    readObject: t.query(
      t.object({ object: t.string(), value: t.literals('class', 'fun') }),
      t.object({ result: t.string() }),
    ),
  },
});
