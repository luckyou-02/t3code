// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { Command, CliError } from "effect/cli";

import { cli } from "../binCli.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../cloud/serviceProtocol.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  type PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { resolveHostCliCommand } from "./invocation.ts";

import packageJson from "../../package.json" with { type: "json" };

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const baseState = {
  version: 1,
  pid: 123,
  port: 3_773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-06-20T00:00:00.000Z",
} as const satisfies PersistedServerRuntimeState;

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Layer.mergeAll(layerCliRuntime, TestConsole.layer));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  provideCliTestLayers(
    Effect.gen(function* () {
      yield* effect;
      return (
        (yield* TestConsole.logLines).findLast(
          (line): line is string => typeof line === "string",
        ) ?? ""
      );
    }),
  );

const testDescriptor = {
  environmentId: "pair-test-environment",
  label: "pair-test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: true },
};

const withDescriptorServer = <A, E, R>(
  run: (origin: string) => Effect.Effect<A, E, R>,
  host = "127.0.0.1",
  descriptor: object = testDescriptor,
) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/.well-known/t3/environment") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(descriptor));
          return;
        }
        response.writeHead(404);
        response.end();
      });
      server.listen(0, host, () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      return run(`http://${host === "::1" ? "[::1]" : host}:${String(address.port)}`);
    },
    (server) => Effect.sync(() => server.close()),
  );

describe("t3 pair", () => {
  it.effect("mints a token and prints a QR pairing URL for a live server", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-test-"));
        const port = Number(new URL(origin).port);
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        yield* persistServerRuntimeState({
          path: statePath,
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port,
          }),
        });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir]));

        assert.include(output, `Pairing with pair-test (${origin})`);
        assert.include(output, `Pairing URL: ${origin}/pair#token=`);
        assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
        assert.include(output, "only reachable from this machine");

        const token = /#token=([A-Z2-9]+)/.exec(output)?.[1];
        assert.isString(token);

        const listed = yield* captureStdout(
          runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
        );
        const credentials = JSON.parse(listed) as ReadonlyArray<{
          readonly label?: string;
          readonly scopes: ReadonlyArray<string>;
        }>;
        assert.equal(credentials.length, 1);
        assert.equal(credentials[0]?.label, "t3 pair");
        assert.deepEqual(credentials[0]?.scopes, AuthStandardClientScopes);
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Effect.provideService(HostProcess.Environment, {
        ...process.env,
        [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          childVersion: packageJson.version,
        }),
      }),
      Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, {
        connected: false,
        send: () => false,
        on: () => undefined,
        off: () => undefined,
      }),
    ),
  );

  it.effect("pairs through the recorded dev web URL for dev servers", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-dev-test-"));
        const port = Number(new URL(origin).port);
        const statePath = NodePath.join(baseDir, "dev", "server-runtime.json");
        yield* persistServerRuntimeState({
          path: statePath,
          state: yield* makePersistedServerRuntimeState({
            config: { host: undefined, devUrl: new URL("http://localhost:5733") },
            port,
          }),
        });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir]));

        assert.include(output, "Pairing URL: http://localhost:5733/pair#token=");
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("ignores runtime state whose recorded pid is no longer alive", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 pair pid test-"));
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: Number(new URL(origin).port),
        });
        yield* persistServerRuntimeState({
          path: statePath,
          state: { ...state, pid: 4_194_305 },
        });

        const error = yield* provideCliTestLayers(
          runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
        );

        const rendered = String(
          typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
        );
        assert.include(rendered, "No running T3 Code server found.");
        const { command } = yield* resolveHostCliCommand("serve", ["--base-dir", baseDir]);
        assert.include(rendered, `\`${command}\``);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // regression: #10516 minting opens the target database with this checkout's
  // migrations, so a worktree must never fall back to the live install.
  it.effect("does not fall back to the shared home from a linked worktree", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-worktree-test-"));
        const worktree = NodePath.join(root, "worktree");
        NodeFS.mkdirSync(worktree);
        NodeFS.writeFileSync(
          NodePath.join(worktree, ".git"),
          `gitdir: ${NodePath.join(root, "repo", ".git", "worktrees", "worktree")}\n`,
        );
        const sharedHome = NodePath.join(root, "shared");
        yield* persistServerRuntimeState({
          path: NodePath.join(sharedHome, "userdata", "server-runtime.json"),
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: Number(new URL(origin).port),
          }),
        });

        const error = yield* provideCliTestLayers(
          runCli(["pair"]).pipe(
            Effect.provideService(HostProcess.WorkingDirectory, worktree),
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_HOME: sharedHome } })),
            ),
            Effect.flip,
          ),
        );

        assert.include(String(error), "No running T3 Code server found.");
        assert.notInclude(String(error), sharedHome);
        assert.deepEqual(NodeFS.readdirSync(NodePath.join(sharedHome, "userdata")), [
          "server-runtime.json",
        ]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // regression: #15492 an older CLI minted into a V1 database the protocol 2
  // server never reads, so pairing must refuse before opening the database.
  it.effect("rejects a server on another protocol before opening its database", () =>
    withDescriptorServer(
      (origin) =>
        Effect.gen(function* () {
          const baseDir = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "t3-pair-protocol-test-"),
          );
          yield* persistServerRuntimeState({
            path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
            state: yield* makePersistedServerRuntimeState({
              config: { host: "127.0.0.1", devUrl: undefined },
              port: Number(new URL(origin).port),
            }),
          });

          const exit = yield* provideCliTestLayers(
            runCli(["pair", "--base-dir", baseDir]).pipe(Effect.exit),
          );

          assert.deepEqual(NodeFS.readdirSync(NodePath.join(baseDir, "userdata")), [
            "server-runtime.json",
          ]);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            assert.include(
              String(Cause.squash(exit.cause)),
              `t3@0.0.45 pair --base-dir ${baseDir}`,
            );
          }
        }),
      "127.0.0.1",
      { ...testDescriptor, serverVersion: "0.0.45", orchestrationProtocolVersion: 1 },
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

describe("auth session revoke", () => {
  // Nothing listens on the recorded port; `server` stubs what fetch meets there instead.
  it.effect.each([
    {
      label: "goes through a running server, which closes open connections",
      recorded: true,
      lockHeld: false,
      server: "answers",
      outcome: "revoked by server",
    },
    {
      label: "writes the database when no server runs",
      recorded: false,
      lockHeld: false,
      server: "none",
      outcome: "revoked locally",
    },
    {
      label: "writes the database when the recorded server has stopped",
      recorded: true,
      lockHeld: false,
      server: "none",
      outcome: "revoked locally",
    },
    {
      label: "changes nothing when a running server refuses the connection",
      recorded: true,
      lockHeld: true,
      server: "none",
      outcome: "RunningServerUnreachableError",
    },
    {
      label: "does not repeat a change locally when the server stops replying mid-request",
      recorded: true,
      lockHeld: false,
      server: "hangs",
      outcome: "RunningServerNoReplyError",
    },
    {
      label: "does not repeat a change locally when the server answers with an error",
      recorded: true,
      lockHeld: false,
      server: "fails",
      outcome: "HttpClientError",
    },
  ] as const)("$label", ({ recorded, lockHeld, server, outcome }) =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-revoke-test-"));
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        const issued = JSON.parse(
          yield* captureStdout(
            runCli(["auth", "session", "issue", "--base-dir", baseDir, "--json"]),
          ),
        ) as { readonly sessionId: string };
        if (recorded) {
          // A port just released has no listener, so connecting to it is refused.
          const port = yield* (yield* NetService.NetService).reserveLoopbackPort("127.0.0.1");
          yield* persistServerRuntimeState({
            path: statePath,
            // An owner id skips the legacy liveness probe, so only the lock decides.
            state: {
              ...baseState,
              pid: process.pid,
              ownerId: "test-owner",
              port,
              origin: `http://127.0.0.1:${port}`,
            },
          });
        }
        if (lockHeld) {
          yield* ServerOwnership.acquireServerOwnership(statePath).pipe(
            Effect.provide(ProcessRunner.layer),
          );
        }

        const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
        const requestStarted = Promise.withResolvers<void>();
        const fetch: typeof globalThis.fetch | undefined =
          server === "answers" || server === "fails"
            ? async (input, init) => {
                requests.push({
                  path: new URL(String(input)).pathname,
                  body: JSON.parse(String(init?.body)),
                });
                return server === "answers"
                  ? Response.json({ revoked: true })
                  : new Response(null, { status: 502 });
              }
            : server === "hangs"
              ? (_input, init) => {
                  requestStarted.resolve();
                  return new Promise((_resolve, reject) =>
                    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
                  );
                }
              : undefined;
        const revoke = runCli([
          "auth",
          "session",
          "revoke",
          "--base-dir",
          baseDir,
          issued.sessionId,
        ]);
        const running = yield* (
          fetch === undefined
            ? revoke
            : revoke.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))
        ).pipe(Effect.exit, Effect.forkChild);
        if (server === "hangs") {
          yield* Effect.promise(() => requestStarted.promise);
          yield* TestClock.adjust("30 seconds");
        }
        const exit = yield* Fiber.join(running);
        const listed = JSON.parse(
          yield* captureStdout(
            runCli(["auth", "session", "list", "--base-dir", baseDir, "--json"]),
          ),
        ) as ReadonlyArray<{ readonly sessionId: string }>;

        assert.deepEqual(
          requests,
          server === "answers" || server === "fails"
            ? [{ path: "/api/auth/clients/revoke", body: { sessionId: issued.sessionId } }]
            : [],
        );
        if (outcome === "revoked by server" || outcome === "revoked locally") {
          assert.isTrue(Exit.isSuccess(exit));
        } else {
          assert.include(Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty), outcome);
        }
        // The stub server revokes nothing, and the CLI's own session is gone either way.
        assert.deepEqual(
          listed.map((session) => session.sessionId),
          outcome === "revoked locally" ? [] : [issued.sessionId],
        );
      }).pipe(Effect.scoped),
    ),
  );
});

describe("auth scope options", () => {
  it.effect.each([
    { group: "pairing", action: "create" },
    { group: "session", action: "issue" },
  ] as const)(
    "issues and persists only the selected scopes for auth $group $action",
    ({ group, action }) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-scopes-test-"),
        );
        const output = yield* captureStdout(
          runCli([
            "auth",
            group,
            action,
            "--base-dir",
            baseDir,
            "--json",
            "--scope",
            "orchestration:read",
            "--scope",
            "access:read",
            "--scope",
            "orchestration:read",
          ]),
        );
        const issued = JSON.parse(output) as { readonly scopes: ReadonlyArray<string> };
        const listOutput = yield* captureStdout(
          runCli(["auth", group, "list", "--base-dir", baseDir, "--json"]),
        );
        const listed = JSON.parse(listOutput) as ReadonlyArray<{
          readonly scopes: ReadonlyArray<string>;
        }>;

        assert.deepEqual(issued.scopes, ["orchestration:read", "access:read"]);
        assert.lengthOf(listed, 1);
        assert.deepEqual(listed[0]?.scopes, issued.scopes);
      }),
  );

  it.effect.each(
    [["pair"], ["auth", "pairing", "create"], ["auth", "session", "issue"]].map((command) => ({
      command,
      label: command.join(" "),
    })),
  )("rejects invalid scopes before running $label", ({ command }) =>
    Effect.gen(function* () {
      const error = yield* runCli([
        ...command,
        "--scope",
        "orchestration:read",
        "--scope",
        "admin",
      ]).pipe(Effect.provide(layerCliRuntime), Effect.flip);

      if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${String(error)}`);
      }
      assert.deepEqual(error.commandPath, ["t3", ...command]);
      const scopeError = error.errors[0];
      if (scopeError?._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${String(scopeError?._tag)}`);
      }
      assert.equal(scopeError.option, "scope");
      assert.equal(scopeError.value, "admin");
    }),
  );
});

describe("auth pairing create --base-url", () => {
  it.effect.each(["192.168.1.5:3773", "localhost:3773", "ftp://localhost:3773"])(
    "rejects %s before issuing a token",
    (baseUrl) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-base-url-test-"));
        const error = yield* runCli([
          "auth",
          "pairing",
          "create",
          "--base-dir",
          baseDir,
          "--base-url",
          baseUrl,
        ]).pipe(Effect.provide(layerCliRuntime), Effect.flip);

        if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
          assert.fail(`Expected ShowHelp, got ${String(error)}`);
        }
        const flagError = error.errors[0];
        if (flagError?._tag !== "InvalidValue") {
          assert.fail(`Expected InvalidValue, got ${String(flagError?._tag)}`);
        }
        assert.equal(flagError.option, "base-url");
        assert.equal(flagError.value, baseUrl);

        const listOutput = yield* captureStdout(
          runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
        );
        assert.deepEqual(JSON.parse(listOutput), []);
      }),
  );

  it.effect.each(["http://192.168.1.5:3773", "https://example.com", "http:localhost:3773"])(
    "prints a pair URL for %s",
    (baseUrl) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-base-url-test-"));
        const output = yield* captureStdout(
          runCli([
            "auth",
            "pairing",
            "create",
            "--base-dir",
            baseDir,
            "--base-url",
            baseUrl,
            "--json",
          ]),
        );
        const issued = JSON.parse(output) as {
          readonly credential: string;
          readonly pairUrl: string;
        };

        assert.equal(issued.pairUrl, `${new URL(baseUrl).origin}/pair#token=${issued.credential}`);
      }),
  );
});

describe("scripted auth output", () => {
  it.effect.each(
    [
      ["auth", "session", "issue", "--token-only"],
      ["auth", "session", "list", "--json"],
      ["auth", "pairing", "list", "--json"],
    ].map((command) => ({ command, label: command.join(" ") })),
  )("prints only the result for $label after removing an abandoned upload", ({ command }) =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-quiet-test-"));
      const attachmentsDir = NodePath.join(baseDir, "userdata", "attachments");
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      // An abandoned upload makes config resolution log that it removed it.
      const abandoned = NodePath.join(attachmentsDir, "abandoned.part");
      NodeFS.writeFileSync(abandoned, "");
      const jan2020Seconds = 1_577_836_800;
      NodeFS.utimesSync(abandoned, jan2020Seconds, jan2020Seconds);
      // The sweep reads Clock, so a week past the upload's mtime makes it expired.
      yield* TestClock.setTime((jan2020Seconds + 7 * 24 * 60 * 60) * 1000);

      const lines = yield* provideCliTestLayers(
        Effect.gen(function* () {
          yield* runCli([...command, "--base-dir", baseDir]);
          return yield* TestConsole.logLines;
        }),
      );

      assert.isFalse(NodeFS.existsSync(abandoned));
      assert.lengthOf(lines, 1);
      const output = String(lines[0]);
      if (command.includes("--json")) {
        assert.deepEqual(JSON.parse(output), []);
      } else {
        assert.match(output.trim(), /^[\w-]+\.[\w-]+/);
      }
    }),
  );
});
