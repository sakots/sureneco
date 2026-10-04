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
  const { electronDist, afterPack, ...rest } = config;
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

it("配布物から既定画面を除去し、アプリ本体は保持する", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, access, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "sureneco-package-"));
  const resources = join(directory, "resources");
  try {
    await mkdir(resources);
    await writeFile(join(resources, "default_app.asar"), "electron default");
    await writeFile(join(resources, "app.asar"), "sureneco");
    const context = {
      appOutDir: directory,
      packager: { getResourcesDir: () => resources },
    };
    await config.afterPack(context);
    await expect(access(join(resources, "default_app.asar"))).rejects.toThrow();
    expect(await readFile(join(resources, "app.asar"), "utf8")).toBe(
      "sureneco",
    );
    await config.afterPack(context);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("配布形式ごとに共通のバージョン接頭辞を使い、次のバージョンにも反映する", () => {
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const libraryRequire = createRequire(
    builderRequire.resolve("app-builder-lib"),
  );
  const { expandMacro } = libraryRequire("./util/macroExpander");
  const { Arch, getArtifactArchName } = libraryRequire("builder-util");
  for (const releaseVersion of [metadata.version, "0.3.0"]) {
    for (const [options, extension, suffix] of [
      [config.deb, "deb", ".amd64.deb"],
      [config.appImage, "AppImage", ".AppImage"],
      [config.nsis, "exe", "_Setup.exe"],
      [config.win, "zip", "_win.zip"],
    ]) {
      const name = expandMacro(
        options?.artifactName ?? "",
        getArtifactArchName(Arch.x64, extension),
        {
          name: metadata.name,
          version: releaseVersion,
        },
        { ext: extension },
      );
      expect(name).toBe(`sureneco_v${releaseVersion}${suffix}`);
    }
  }
});

it("GitHub更新メタデータを生成し、ローカルビルドから公開しない", async () => {
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const libraryRequire = createRequire(
    builderRequire.resolve("app-builder-lib"),
  );
  const { validateConfiguration } = libraryRequire("./util/config/config");
  await validateConfiguration(metadata.build, { isEnabled: false });
  expect(config.publish).toEqual({
    provider: "github",
    owner: "sakots",
    repo: "sureneco",
  });
  for (const target of ["win", "linux"]) {
    expect(metadata.scripts[`package:${target}`]).toContain("--publish never");
  }
});
