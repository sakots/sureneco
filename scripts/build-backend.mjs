import { build } from "esbuild";
await build({
  entryPoints: ["src/backend/engine.ts"],
  bundle: true,
  platform: "neutral",
  target: "es2022",
  format: "iife",
  globalName: "surenecoEngine",
  outfile: "dist/backend/engine.js",
});
