import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { getHostEnvironmentId } from "./localEnvironment.ts";

describe("local environment IPC", () => {
  it.effect("reads the shared home identity without creating one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const environment = DesktopEnvironment.DesktopEnvironment.of({
        path,
        stateDir,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const read = getHostEnvironmentId
        .handler(undefined)
        .pipe(Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment));
      assert.strictEqual(yield* read, null);
      assert.isFalse(yield* fs.exists(path.join(stateDir, "environment-id")));
      yield* fs.writeFileString(path.join(stateDir, "environment-id"), "  service-id\n");
      assert.strictEqual(yield* read, "service-id");
      yield* fs.writeFileString(path.join(stateDir, "environment-id"), "\n");
      assert.strictEqual(yield* read, null);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
