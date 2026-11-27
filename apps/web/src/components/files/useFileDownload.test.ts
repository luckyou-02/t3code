import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { useFileDownload } from "./useFileDownload";

const state = vi.hoisted(() => ({
  canRead: true,
  createUrl: vi.fn(async () => ({
    _tag: "Success",
    value: { relativeUrl: "/api/assets/t/index.html" },
  })),
}));

vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useGT: () => (text: string) => text,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.canRead,
  readPreparedConnection: () => ({ httpBaseUrl: "https://host.example/" }) as never,
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.createUrl }));

const environmentId = EnvironmentId.make("env");

afterEach(() => {
  state.canRead = true;
  state.createUrl.mockClear();
  vi.unstubAllGlobals();
});

it("streams the host file through desktopBridge.downloadUrl in desktop, and only with file access", async () => {
  const downloaded = Promise.withResolvers<string>();
  const downloadUrl = vi.fn(async (url: string) => {
    downloaded.resolve(url);
    return true;
  });
  vi.stubGlobal("window", { desktopBridge: { downloadUrl } });

  useFileDownload(environmentId)!("/repo", Promise.resolve("/repo/dist/index.html"));
  await expect(downloaded.promise).resolves.toBe("https://host.example/api/assets/t/index.html");
  expect(downloadUrl).toHaveBeenCalledWith("https://host.example/api/assets/t/index.html");
  expect(state.createUrl).toHaveBeenCalledWith({
    environmentId,
    input: {
      resource: {
        _tag: "draft-workspace-file",
        cwd: "/repo",
        path: "/repo/dist/index.html",
        disposition: "attachment",
      },
    },
  });
  state.canRead = false;
  expect(useFileDownload(environmentId)).toBeNull();
});

it("streams via an attachment anchor link on web without buffering into a Blob", async () => {
  const clicked = Promise.withResolvers<void>();
  const anchor = {
    href: "",
    download: "",
    rel: "",
    style: { display: "" },
    click: vi.fn(() => clicked.resolve()),
    remove: vi.fn(),
  };
  const append = vi.fn();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: vi.fn(() => anchor),
    body: { append },
  });

  useFileDownload(environmentId)!("/repo", "/repo/dist/index.html");
  await clicked.promise;
  expect(anchor.href).toBe("https://host.example/api/assets/t/index.html");
  expect(anchor.download).toBe("index.html");
  expect(anchor.rel).toBe("noopener");
  expect(append).toHaveBeenCalledWith(anchor);
  expect(anchor.remove).toHaveBeenCalledOnce();
});
