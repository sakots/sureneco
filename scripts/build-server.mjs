import { build } from "esbuild";

await build({
  entryPoints: ["server/main.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/server.mjs",
});
