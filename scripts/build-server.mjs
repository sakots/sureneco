import { build } from "esbuild";
await build({
  entryPoints: [
    "server/main.ts",
    "server/detection-worker.ts",
    "server/firebase-worker.ts",
  ],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outdir: "dist/server",
  outExtension: { ".js": ".mjs" },
  packages: "external",
});
