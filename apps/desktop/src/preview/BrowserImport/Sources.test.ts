// @effect-diagnostics nodeBuiltinImport:off - Builds a Chromium-shaped cookie
// table with the same native bindings the source reads.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as NodeSqlite from "node:sqlite";

import type { BrowserImportPathContext } from "./Sources.ts";
import {
  BROWSER_IMPORT_SOURCES,
  resolveCookieDatabase,
  isSourceInstalled,
  isSourceRunning,
  listSourceProfiles,
  sourcePathContext,
  windowsChromiumCookiesAreHeld,
} from "./Sources.ts";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;
const firefox = BROWSER_IMPORT_SOURCES.find((source) => source.id === "firefox")!;
const zen = BROWSER_IMPORT_SOURCES.find((source) => source.id === "zen")!;

const withSourceHome = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-sources-" });
  const context = yield* sourcePathContext.pipe(
    Effect.provideService(HostProcess.Environment, {
      HOME: home,
      APPDATA: NodePath.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
    }),
    Effect.provideService(HostProcess.Platform, "win32"),
  );
  yield* fileSystem.makeDirectory(userDataDirectory(context), { recursive: true });
  return context;
});

const userDataDirectory = (context: BrowserImportPathContext) => {
  const root = helium.userDataDirectory(context);
  if (root === undefined) throw new Error("Helium has no Windows user-data directory");
  return root;
};

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

const writeCookieDatabase = (file: string, count: number) =>
  Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(file);
    database.exec("create table cookies (host_key text, name text)");
    const insert = database.prepare("insert into cookies (host_key, name) values (?, ?)");
    for (let index = 0; index < count; index += 1) insert.run("example.test", `c${index}`);
    database.close();
  });

const writeFirefoxCookieDatabase = (
  file: string,
  defaultContainerCount: number,
  containerCount: number,
) =>
  Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(file);
    database.exec("create table moz_cookies (originAttributes text not null)");
    const insert = database.prepare("insert into moz_cookies (originAttributes) values (?)");
    for (let index = 0; index < defaultContainerCount; index += 1) insert.run("");
    for (let index = 0; index < containerCount; index += 1) insert.run("^userContextId=2");
    database.close();
  });

describe("isSourceRunning", () => {
  it.effect("uses the held cookie database as Chromium's Windows running signal", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-helium-windows-lock-",
        });
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: home,
            LOCALAPPDATA: home,
          }),
          Effect.provideService(HostProcess.Platform, "win32"),
        );
        const profile = context.path.join(helium.userDataDirectory(context)!, "Default");
        const database = context.path.join(profile, "Network", "Cookies");
        yield* fileSystem.makeDirectory(context.path.join(profile, "Network"), { recursive: true });
        yield* writeCookieDatabase(database, 1);

        const probed: string[] = [];
        assert.isTrue(
          yield* windowsChromiumCookiesAreHeld(helium, context, (path) =>
            Effect.sync(() => {
              probed.push(path);
              return true;
            }),
          ),
        );
        assert.deepEqual(probed, [database]);
      }),
    ),
  );
});

describe("isSourceInstalled", () => {
  it.effect("ignores a user-data directory that holds no cookie database", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = userDataDirectory(context);

        yield* fileSystem.makeDirectory(`${root}/NativeMessagingHosts`, { recursive: true });
        assert.isFalse(yield* isSourceInstalled(helium, context));

        yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "db");
        assert.isTrue(yield* isSourceInstalled(helium, context));

        yield* fileSystem.remove(`${root}/Default`, { recursive: true });
        yield* fileSystem.makeDirectory(`${root}/Profile 1`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Profile 1/Cookies`, "db");
        assert.isTrue(yield* isSourceInstalled(helium, context));

        yield* fileSystem.remove(root, { recursive: true });
        assert.isFalse(yield* isSourceInstalled(helium, context));
      }),
    ),
  );
});

describe("listSourceProfiles", () => {
  it.effect("reads the profile names the browser shows", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        yield* fileSystem.writeFileString(
          `${userDataDirectory(context)}/Local State`,
          `{"profile":{"info_cache":{"Default":{"name":"You"},"Profile 2":{"name":"  "}}}}`,
        );

        assert.deepEqual(yield* listSourceProfiles(helium, context), [
          { directory: "Default", name: "You" },
          { directory: "Profile 2", name: "Profile 2" },
        ]);
      }),
    ),
  );

  it.effect("scans for profiles when Local State is malformed", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = userDataDirectory(context);
        yield* fileSystem.writeFileString(`${root}/Local State`, "{not-json");
        yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "db");

        assert.deepEqual(yield* listSourceProfiles(helium, context), [
          { directory: "Default", name: "Default" },
        ]);
      }),
    ),
  );

  it.effect("discovers profiles with cookies under Network/ (Chromium 127+)", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = userDataDirectory(context);
        yield* fileSystem.makeDirectory(`${root}/Default/Network`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Default/Network/Cookies`, "db");

        assert.deepEqual(yield* listSourceProfiles(helium, context), [
          { directory: "Default", name: "Default" },
        ]);
      }),
    ),
  );

  it.effect("falls through to the legacy database when Network/Cookies is a directory", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* withSourceHome();
        const root = helium.userDataDirectory(paths);
        yield* fileSystem.makeDirectory(`${root}/Default/Network/Cookies`, { recursive: true });
        yield* writeCookieDatabase(`${root}/Default/Cookies`, 2);

        const [profile] = yield* listSourceProfiles(helium, paths);
        assert.equal(profile?.directory, "Default");
        assert.equal(profile?.cookieCount, 2);
      }),
    ),
  );
});

describe("cookieDatabaseCandidatePaths", () => {
  it.effect("resolves the live Network/ jar over a leftover root Cookies", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = userDataDirectory(context);
        yield* fileSystem.makeDirectory(`${root}/Default/Network`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Default/Network/Cookies`, "live");
        yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "stale");

        assert.equal(
          yield* resolveCookieDatabase(helium, context, "Default"),
          context.path.join(root, "Default", "Network", "Cookies"),
        );
        yield* fileSystem.remove(`${root}/Default/Cookies`);
        assert.isTrue(yield* isSourceInstalled(helium, context));
      }),
    ),
  );
});

describe("Zen", () => {
  it.effect("resolves Windows user-data roots for supported browsers", () =>
    run(
      Effect.gen(function* () {
        const windowsContext = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: "C:\\Users\\zen-user",
            APPDATA: "C:\\Users\\zen-user\\AppData\\Roaming",
            LOCALAPPDATA: "C:\\Users\\zen-user\\AppData\\Local",
          }),
          Effect.provideService(HostProcess.Platform, "win32"),
        );

        assert.equal(zen.name, "Zen");
        assert.equal(zen.engine, "firefox");
        assert.deepEqual([...zen.platforms], ["win32"]);
        assert.equal(
          zen.userDataDirectory(windowsContext),
          windowsContext.path.join("C:\\Users\\zen-user\\AppData\\Roaming", "zen"),
        );
        assert.equal(
          helium.userDataDirectory(windowsContext),
          windowsContext.path.join(
            "C:\\Users\\zen-user\\AppData\\Local",
            "imput",
            "Helium",
            "User Data",
          ),
        );
      }),
    ),
  );

  it.effect("discovers Zen profiles through its Firefox-compatible metadata", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = zen.userDataDirectory(context)!;
        yield* fileSystem.makeDirectory(root, { recursive: true });
        const profile = context.path.join(root, "Profiles", "zen.default");
        yield* fileSystem.makeDirectory(profile, { recursive: true });
        yield* writeFirefoxCookieDatabase(context.path.join(profile, "cookies.sqlite"), 2, 1);
        yield* fileSystem.makeDirectory(context.path.join(root, "Profiles", "empty.default"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          context.path.join(root, "profiles.ini"),
          [
            "[Profile0]",
            "Name=Zen",
            "IsRelative=1",
            "Path=Profiles/zen.default",
            "ZenAvatarPath=chrome://browser/content/zen-avatars/avatar-55.svg",
            "Default=1",
            "",
            "[Profile1]",
            "Name=Empty",
            "IsRelative=1",
            "Path=Profiles/empty.default",
            "",
          ].join("\n"),
        );

        assert.deepEqual(yield* listSourceProfiles(zen, context), [
          {
            directory: context.path.join("Profiles", "zen.default"),
            name: "Zen",
            cookieCount: 2,
          },
        ]);
        assert.isTrue(yield* isSourceInstalled(zen, context));
        assert.isFalse(yield* isSourceRunning(zen, context));
        assert.equal(
          yield* resolveCookieDatabase(zen, context, context.path.join("Profiles", "zen.default")),
          context.path.join(profile, "cookies.sqlite"),
        );
      }),
    ),
  );
});

describe("listSourceProfiles Firefox fallback", () => {
  it.effect("scans the Windows profile location and excludes stale entries", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const context = yield* withSourceHome();
        const profileDirectory = NodePath.join("Profiles", "windows.default");
        const root = firefox.userDataDirectory(context)!;
        const scanRoot = path.join(root, "Profiles");
        yield* fileSystem.makeDirectory(path.join(root, profileDirectory), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(root, profileDirectory, "cookies.sqlite"),
          "db",
        );
        yield* fileSystem.makeDirectory(path.join(scanRoot, "stale.default"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(scanRoot, "stale-file.default"), "not-dir");

        assert.deepEqual(yield* listSourceProfiles(firefox, context), [
          {
            directory: profileDirectory,
            name: path.basename(profileDirectory),
          },
        ]);
      }),
    ),
  );

  it.effect("scans for profiles when profiles.ini declares only ones without cookies", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const context = yield* withSourceHome();
        const root = firefox.userDataDirectory(context)!;
        yield* fileSystem.makeDirectory(path.join(root, "Profiles", "stale.default"), {
          recursive: true,
        });
        const realDirectory = path.join(root, "Profiles", "real.default");
        yield* fileSystem.makeDirectory(realDirectory, { recursive: true });
        yield* writeFirefoxCookieDatabase(path.join(realDirectory, "cookies.sqlite"), 3, 0);
        yield* fileSystem.writeFileString(
          path.join(root, "profiles.ini"),
          ["[Profile0]", "Name=Stale", "IsRelative=1", "Path=Profiles/stale.default"].join("\n"),
        );

        assert.deepEqual(yield* listSourceProfiles(firefox, context), [
          {
            directory: path.join("Profiles", "real.default"),
            name: "real.default",
            cookieCount: 3,
          },
        ]);
        assert.isTrue(yield* isSourceInstalled(firefox, context));
      }),
    ),
  );

  it.effect("counts only importable cookies for declared and fallback profiles", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const context = yield* withSourceHome();
        const root = firefox.userDataDirectory(context)!;
        const declaredDirectory = path.join(root, "Profiles", "declared.default");
        yield* fileSystem.makeDirectory(declaredDirectory, { recursive: true });
        yield* writeFirefoxCookieDatabase(path.join(declaredDirectory, "cookies.sqlite"), 2, 3);
        yield* fileSystem.writeFileString(
          path.join(root, "profiles.ini"),
          ["[Profile0]", "Name=Declared", "IsRelative=1", "Path=Profiles/declared.default"].join(
            "\n",
          ),
        );

        assert.deepEqual(yield* listSourceProfiles(firefox, context), [
          {
            directory: path.join("Profiles", "declared.default"),
            name: "Declared",
            cookieCount: 2,
          },
        ]);

        yield* fileSystem.remove(path.join(root, "profiles.ini"));
        const fallbackDirectory = path.join(root, "Profiles", "fallback.default");
        yield* fileSystem.makeDirectory(fallbackDirectory, { recursive: true });
        yield* writeFirefoxCookieDatabase(path.join(fallbackDirectory, "cookies.sqlite"), 1, 4);

        assert.deepEqual(yield* listSourceProfiles(firefox, context), [
          {
            directory: path.join("Profiles", "declared.default"),
            name: "declared.default",
            cookieCount: 2,
          },
          {
            directory: path.join("Profiles", "fallback.default"),
            name: "fallback.default",
            cookieCount: 1,
          },
        ]);
      }),
    ),
  );
});

describe("isSourceRunning for Firefox", () => {
  it.effect("does not treat a stale parent.lock file as a running browser", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-firefox-" });
        const context = yield* sourcePathContext.pipe(
          // Without APPDATA, the Windows Firefox fixture would escape into the repo.
          Effect.provideService(HostProcess.Environment, {
            HOME: home,
            APPDATA: `${home}/AppData/Roaming`,
          }),
          Effect.provideService(HostProcess.Platform, "win32"),
        );
        const root = firefox.userDataDirectory(context)!;
        const profile = `${root}/Profiles/gx7x7fqx.default-release`;
        yield* fileSystem.makeDirectory(profile, { recursive: true });
        yield* fileSystem.writeFileString(`${profile}/cookies.sqlite`, "db");

        yield* fileSystem.writeFileString(`${profile}/parent.lock`, "");
        assert.isFalse(yield* isSourceRunning(firefox, context));
      }),
    ),
  );
});

describe("listSourceProfiles hardening", () => {
  it.effect("drops profile directories that are not a single plain segment", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        yield* fileSystem.writeFileString(
          `${userDataDirectory(context)}/Local State`,
          `{"profile":{"info_cache":{"Default":{"name":"You"},"../../../../secrets":{"name":"Escape"},"a/b":{"name":"Nested"},"..":{"name":"Parent"}}}}`,
        );

        const profiles = yield* listSourceProfiles(helium, context);

        assert.deepEqual(
          profiles.map((profile) => profile.directory),
          ["Default"],
        );
      }),
    ),
  );
});
