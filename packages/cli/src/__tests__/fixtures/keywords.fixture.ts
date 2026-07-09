import type { BridgeContract } from '@malopezr7/bridgekit/contract';
import { defineContract, t } from '@malopezr7/bridgekit/contract';

export const KeywordsFixture: BridgeContract<unknown> = defineContract('compile.keywords', {
  methods: {
    object: t.query(
      t.object({ object: t.string(), fun: t.string(), is: t.boolean() }),
      t.object({ case: t.string() }),
    ),
    switch: t.query(t.object({ case: t.string() }), t.string()),
    readObject: t.query(
      t.object({ object: t.string(), value: t.literals('class', 'fun') }),
      t.object({
        result: t.string(),
        mode: t.enum({ object: 0, fun: 1, case: 2 }),
        status: t.union('is', {
          object: t.object({ value: t.string() }),
          switch: t.object({ value: t.string() }),
        }),
        choice: t.oneOf([t.object({ object: t.string() }), t.literals('class')] as const),
      }),
    ),
    getLargeCounter: t.query(t.int64()),
  },
  state: {
    template: t.state(t.string(), 'cost is $amount'),
    control: t.state(t.string(), 'a\u0001b'),
  },
});
