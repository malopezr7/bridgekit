import { defineContract, t } from '../contract';
import type { BridgeStreamSubscribeOptions } from '../index';
import { type ConsumerOf, Stream } from '../markers';

const StreamOptionsContract = defineContract('typecheck.stream-options', {
  streams: { values: Stream(t.number()) },
});

type StreamOptionsConsumer = ConsumerOf<typeof StreamOptionsContract>;
declare const source: ReturnType<StreamOptionsConsumer['values']>;
const options: BridgeStreamSubscribeOptions = {
  onComplete: () => {},
  onError: () => {},
};

source.subscribe(() => {}, options);
