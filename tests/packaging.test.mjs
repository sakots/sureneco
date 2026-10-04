import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import config from "../electron-builder.config.mjs";
const require = createRequire(import.meta.url);
const metadata = require("../package.json");
const version = require("electron/package.json").version;
const context = { platformName: process.platform, arch: process.arch, version };

it("同じOS・CPU・バージョンでは展開済みElectronを使う", async () => {
  expect(await config.electronDist(context)).toBe(
    join(dirname(require.resolve("electron/package.json")), "dist"),
  );
  const { electronDist, ...rest } = config;
  expect(rest).toEqual(metadata.build);
  expect(metadata.scripts["package:win"]).toContain("install-electron");
  expect(metadata.scripts["package:win"]).toContain(
    "--config electron-builder.config.mjs",
  );
  expect(metadata.scripts["package:linux"]).toContain(
    "--config electron-builder.config.mjs",
  );
});
it("別OS・CPU・バージョンにはホストのElectronを流用しない", async () => {
  for (const change of [
    { platformName: process.platform === "win32" ? "linux" : "win32" },
    { arch: process.arch === "x64" ? "arm64" : "x64" },
    { version: "0.0.0" },
  ]) {
    expect(await config.electronDist({ ...context, ...change })).toBeNull();
  }
});

it("Windows用インストーラーとZIP版を同時に生成する", () => {
  expect(config.win.target).toEqual(["nsis", "zip"]);
});
