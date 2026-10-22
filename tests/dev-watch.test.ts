import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createServer } from "vite";
import { expect, it, vi } from "vitest";
import config from "../vite.config";

it("does not watch SDK/native/release trees but still detects frontend edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "sureneco-watch-"));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    for (const directory of [
      ".android-sdk/ndk",
      "src-tauri/target",
      "release",
      "src/renderer",
    ]) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(
        join(root, directory, "sample.ts"),
        "export const value = 1;",
      );
    }
    server = await createServer({
      configFile: false,
      root,
      server: { ...config.server, middlewareMode: true, hmr: false },
    });
    await vi.waitFor(() => {
      expect(Object.keys(server!.watcher.getWatched())).toContain(
        join(root, "src/renderer"),
      );
    });
    const directories = Object.keys(server.watcher.getWatched()).map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    );
    expect(directories).toContain("src/renderer");
    expect(
      directories.some((path) =>
        /^(\.android-sdk|src-tauri|release)(\/|$)/.test(path),
      ),
    ).toBe(false);
    const source = join(root, "src/renderer/sample.ts");
    const changed = new Promise<string>((resolve) =>
      server!.watcher.once("change", resolve),
    );
    await writeFile(source, "export const value = 2;");
    expect(await changed).toBe(source);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
