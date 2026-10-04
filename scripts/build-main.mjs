import { build } from "esbuild";
await build({
  entryPoints: ["src/main/main.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: "dist/main",
  external: ["electron"],
});
await build({
  entryPoints: ["src/main/preload.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/main/preload.cjs",
  external: ["electron"],
});
