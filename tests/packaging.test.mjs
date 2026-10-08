import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactName, createManifest } from "../scripts/release-manifest.mjs";

it("バージョン付きの共通配布名と形式ごとの更新先を作る", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sureneco-release-"));
  try {
    const names = [
      "sureneco_v0.6.0_amd64.deb",
      "sureneco_v0.6.0.AppImage",
      "sureneco_v0.6.0_Setup.exe",
      "sureneco_v0.6.0_win.zip",
    ];
    expect(
      ["deb", "appimage", "nsis", "zip"].map((target) =>
        artifactName("0.6.0", target),
      ),
    ).toEqual(names);
    for (const name of names.slice(0, 3)) {
      await writeFile(join(directory, name), "artifact");
      await writeFile(join(directory, `${name}.sig`), "signature");
    }
    const manifest = await createManifest(directory, "0.6.0");
    expect(Object.keys(manifest.platforms)).toEqual(
      expect.arrayContaining([
        "linux-x86_64-deb",
        "linux-x86_64-appimage",
        "windows-x86_64-nsis",
        "windows-x86_64",
      ]),
    );
    expect(manifest.platforms["linux-x86_64-deb"].url).toBe(
      "https://github.com/sakots/sureneco/releases/download/v0.6.0/sureneco_v0.6.0_amd64.deb",
    );
    expect(manifest.platforms["windows-x86_64-nsis"].signature).toBe(
      "signature",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
