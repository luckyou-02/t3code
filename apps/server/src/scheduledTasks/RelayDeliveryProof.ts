import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export class RelayDeliveryProof extends Context.Service<
  RelayDeliveryProof,
  {
    readonly verify: (input: {
      readonly headers: Readonly<Record<string, string>>;
      readonly hookId: string;
    }) => Effect.Effect<
      Option.Option<{ readonly deliveryId: string; readonly receivedAt: string }>
    >;
  }
>()("t3/scheduledTasks/RelayDeliveryProof") {}

export const layer = Layer.succeed(
  RelayDeliveryProof,
  RelayDeliveryProof.of({
    verify: Effect.fn("RelayDeliveryProof.verify")(function* () {
      return Option.none();
    }),
  }),
);
