import { describe, expect, it } from "@effect/vitest";

import { presentConnectionDiagnosis } from "./diagnosis.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type SupervisorConnectionState,
} from "./model.ts";

const backoff = (lastFailure: ConnectionAttemptError): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 3,
  lastFailure,
  retryAt: Date.UTC(2026, 9, 19, 12, 0, 30),
});

const diagnose = (state: SupervisorConnectionState, via: "relay" | "direct" = "relay") =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state, via });

const results = (state: SupervisorConnectionState, via?: "relay" | "direct") =>
  diagnose(state, via)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

describe("presentConnectionDiagnosis", () => {
  it("reports this device as offline before any other hop", () => {
    const state = {
      ...backoff(new ConnectionTransientError({ reason: "network", detail: "Offline" })),
      network: "offline" as const,
    };
    expect(diagnose(state)?.headline).toBe("This device is offline");
    expect(results(state)?.[0]).toBe("device:failed");
  });

  it("does not report hops as working when the failure names none", () => {
    const failure = new ConnectionBlockedError({
      reason: "authentication",
      detail: "Your cloud sign-in changed. Sign in again to authorize the environment.",
    });
    expect(results(backoff(failure))).not.toContainEqual(expect.stringMatching(/:ok$/));
  });
});
