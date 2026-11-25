import {
  AuthRelayReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { requireEnvironmentScope } from "../auth/http.ts";

const connectDisabledError = () =>
  Effect.fail(new EnvironmentHttpForbiddenError({ message: "T3 Connect is disabled in this build." }));

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connect",
  Effect.fnUntraced(function* (handlers) {
    return handlers
      .handle("linkProof", connectDisabledError)
      .handle("relayConfig", connectDisabledError)
      .handle("linkState", () =>
        requireEnvironmentScope(AuthRelayReadScope).pipe(
          Effect.as({
            linked: false,
            cloudUserId: null,
            relayUrl: null,
            relayIssuer: null,
            publishAgentActivity: false,
            linkableHere: false,
          }),
        ),
      )
      .handle("checkReachability", connectDisabledError)
      .handle("unlink", connectDisabledError)
      .handle("preferences", connectDisabledError)
      .handle("liveActivityPreference", connectDisabledError)
      .handle("health", connectDisabledError)
      .handle("t3MintCredential", connectDisabledError);
  }),
);
