import { build } from "esbuild";
import { rm } from "node:fs/promises";
await rm(new URL("../dist/server", import.meta.url), {
  recursive: true,
  force: true,
});
await build({
  entryPoints: ["server/main.ts", "server/detection-worker.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outdir: "dist/server",
  outExtension: { ".js": ".mjs" },
  packages: "external",
});
