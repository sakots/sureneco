import { EventEmitter } from "node:events";
import type { BuildResult } from "esbuild";
import { expect, it, vi } from "vitest";

const results = vi.hoisted(() => [] as BuildResult[]);
vi.mock("esbuild", async (importOriginal) => {
  const actual = await importOriginal<typeof import("esbuild")>();
  return {
    build: async (options: import("esbuild").BuildOptions) => {
      const result = await actual.build({
        ...options,
        write: false,
        metafile: true,
      });
      results.push(result);
      return result;
    },
  };
});
vi.mock("electron", () => ({ default: "electron" }));
vi.mock("node:child_process", () => ({ spawn: () => new EventEmitter() }));
vi.mock("vite", () => ({
  createServer: async () => ({ listen: async () => {} }),
}));

it("開発用の実ビルドでelectron-updaterをESMバンドルへ取り込まない", async () => {
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  try {
    const devScript = "../scripts/dev.mjs";
    await import(devScript);
    const main = results.find((result) =>
      Object.keys(result.metafile!.outputs).some((path) =>
        path.endsWith("main.js"),
      ),
    )!;
    expect(
      Object.values(main.metafile!.outputs).flatMap((output) => output.imports),
    ).toContainEqual(
      expect.objectContaining({ path: "electron-updater", external: true }),
    );
  } finally {
    on.mockRestore();
  }
});
