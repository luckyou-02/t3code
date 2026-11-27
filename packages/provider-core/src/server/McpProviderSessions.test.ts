import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "./McpProviderSessions.ts";

describe("McpProviderSessions tool results", () => {
  const threadId = ThreadId.make("thread-tool-results");

  it.effect(
    "requires exact (tool, input, output) match when reported and refuses ambiguous differing outputs",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "A" },
          { isError: true },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "B" },
          { sentMessage: "B" },
        );

        // A reported error for input B must not drain A's error or B's success.
        assert.strictEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "B" },
            { isError: true },
          ),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "A" },
            { isError: true },
          ),
          { isError: true },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "B" }),
          { sentMessage: "B" },
        );

        // Identical inputs with identical outputs are interchangeable.
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );

        // Identical inputs with differing outputs stay unclaimed on input-only lookup.
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-1" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-2" },
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "delegate_task",
            { task: "Audit" },
            { taskId: "task-2" },
          ),
          { taskId: "task-2" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          { taskId: "task-1" },
        );
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("drops the oldest screenshot and its same-input siblings once a thread is full", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const shot = (fill: string) => ({
        content: [{ type: "image", mimeType: "image/png", data: fill.repeat(12 * 1024 * 1024) }],
      });
      const phone = { deviceId: "phone" };
      const tablet = { deviceId: "tablet" };
      const watch = { deviceId: "watch" };
      const take = (thread: ThreadId, input: unknown) =>
        sessions.takeToolResult(thread, "device_screenshot", input);

      yield* sessions.recordToolResult(threadId, "device_screenshot", phone, shot("A"));
      yield* sessions.recordToolResult(threadId, "device_screenshot", tablet, shot("B"));
      yield* sessions.recordToolResult(threadId, "device_screenshot", watch, shot("C"));
      assert.isUndefined(yield* take(threadId, phone));
      // A later same-input result must not be handed via input-only lookup to the evicted earlier call.
      yield* sessions.recordToolResult(threadId, "device_screenshot", phone, {
        content: [{ type: "image", mimeType: "image/png", data: "D" }],
      });
      assert.isUndefined(yield* take(threadId, phone));
      assert.deepEqual(yield* take(threadId, tablet), shot("B"));
      assert.deepEqual(yield* take(threadId, watch), shot("C"));

      // Keeping the second phone shot alone would hand it to the first phone call.
      const siblings = ThreadId.make("thread-tool-results-siblings");
      yield* sessions.recordToolResult(siblings, "device_screenshot", phone, shot("A"));
      yield* sessions.recordToolResult(siblings, "device_screenshot", tablet, shot("B"));
      yield* sessions.recordToolResult(siblings, "device_screenshot", phone, shot("C"));
      assert.isUndefined(yield* take(siblings, phone));
      assert.deepEqual(yield* take(siblings, tablet), shot("B"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("recovers html_preview screenshots when Antigravity truncates long inline HTML", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const longHtml = `<html><body>${"a".repeat(9_000)}unique-tail</body></html>`;
      const truncatedHtml = `[Earlier output truncated]\n\n${longHtml.slice(-8_000)}`;
      const previewShot = {
        content: [{ type: "image", mimeType: "image/png", data: "PREVIEWPNG" }],
        structuredContent: { contentHeight: 420 },
      };

      yield* sessions.recordToolResult(
        threadId,
        "html_preview",
        { html: longHtml, width: 728, appearance: "dark" },
        previewShot,
      );
      assert.isUndefined(
        yield* sessions.takeToolResult(threadId, "html_preview", {
          html: truncatedHtml,
          width: 390,
          appearance: "dark",
        }),
      );
      assert.deepEqual(
        yield* sessions.takeToolResult(threadId, "html_preview", {
          html: truncatedHtml,
          width: 728,
          appearance: "dark",
        }),
        previewShot,
      );
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect(
    "poisons exact keys of collaterally evicted html_preview entries across count and byte limits",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const countThread = ThreadId.make("thread-html-collateral-count");
        const htmlA = { html: "<p>A</p>", width: 728, appearance: "dark" };
        const htmlB = { html: "<p>B</p>", width: 728, appearance: "dark" };
        yield* sessions.recordToolResult(countThread, "html_preview", htmlA, { id: "a1" });
        yield* sessions.recordToolResult(countThread, "html_preview", htmlB, { id: "b1" });
        for (let i = 0; i < 64; i++) {
          yield* sessions.recordToolResult(
            countThread,
            "send_to_user",
            { message: `m-${i}` },
            { ok: true },
          );
        }
        yield* sessions.recordToolResult(countThread, "html_preview", htmlB, { id: "b2" });
        assert.isUndefined(yield* sessions.takeToolResult(countThread, "html_preview", htmlB));
        assert.deepEqual(
          yield* sessions.takeToolResult(countThread, "html_preview", htmlB, { id: "b2" }),
          { id: "b2" },
        );

        const byteThread = ThreadId.make("thread-html-collateral-bytes");
        const bigShot = (fill: string) => ({
          content: [{ type: "image", mimeType: "image/png", data: fill.repeat(12 * 1024 * 1024) }],
        });
        yield* sessions.recordToolResult(byteThread, "html_preview", htmlA, bigShot("A"));
        yield* sessions.recordToolResult(byteThread, "html_preview", htmlB, bigShot("B"));
        yield* sessions.recordToolResult(byteThread, "device_screenshot", { id: 1 }, bigShot("C"));
        yield* sessions.recordToolResult(byteThread, "html_preview", htmlB, { id: "b3" });
        assert.isUndefined(yield* sessions.takeToolResult(byteThread, "html_preview", htmlB));
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect(
    "bounds per-turn eviction tracking and disables input-only recovery once saturated",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const saturatedThread = ThreadId.make("thread-eviction-cap");
        for (let i = 0; i < 340; i++) {
          yield* sessions.recordToolResult(saturatedThread, "send_to_user", { i }, { i });
        }
        const fresh = { i: 999 };
        yield* sessions.recordToolResult(saturatedThread, "send_to_user", fresh, { fresh: true });
        assert.isUndefined(yield* sessions.takeToolResult(saturatedThread, "send_to_user", fresh));
        assert.deepEqual(
          yield* sessions.takeToolResult(saturatedThread, "send_to_user", fresh, { fresh: true }),
          { fresh: true },
        );
        yield* sessions.clearToolResults(saturatedThread);
        yield* sessions.recordToolResult(saturatedThread, "send_to_user", fresh, { fresh: true });
        assert.deepEqual(yield* sessions.takeToolResult(saturatedThread, "send_to_user", fresh), {
          fresh: true,
        });
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("drops stale-session writes and clears unconsumed results on clearToolResults", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("env-tool-results"),
        threadId,
        providerSessionId: "session-2",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer token",
        browserToolsAvailable: false,
      });
      // A handler finishing for replaced session-1 must not populate session-2.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Old" },
        { sentMessage: "Old" },
        { providerSessionId: "session-1" },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Old" }),
        undefined,
      );

      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Current" },
        { sentMessage: "Current" },
        { providerSessionId: "session-2" },
      );
      const turn1Epoch = yield* sessions.toolResultEpoch(threadId);
      yield* sessions.clearToolResults(threadId);
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Current" }),
        undefined,
      );

      // A handler started in turn 1 that finishes after turn cleanup must not populate turn 2,
      // even when the same provider session is reused.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Late from turn 1" },
        { sentMessage: "Late from turn 1" },
        { providerSessionId: "session-2", epoch: turn1Epoch },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Late from turn 1" }),
        undefined,
      );
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});
