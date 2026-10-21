import { build } from "esbuild";
import { execFileSync } from "node:child_process";

await build({
  entryPoints: ["server/worker.ts"],
  bundle: true,
  platform: "neutral",
  target: "es2022",
  format: "iife",
  globalName: "surenecoWorker",
  outfile: "dist/server/worker.js",
});
execFileSync(
  "cargo",
  ["build", "--release", "--manifest-path", "server/worker/Cargo.toml"],
  { stdio: "inherit" },
);
