import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { appLinkBaseUrl } from "./appLinkBaseUrl";

it("builds a thread link from the local browser origin", () => {
  const target = threadChipCopyTarget(
    { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("thread") },
    "Local thread",
    appLinkBaseUrl(),
  );

  expect(target.value).toBe(new URL("/threads/local/thread", window.location.href).href);
});
