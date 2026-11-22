import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const worker = "trials/php-fcm/worker";

await build({
  entryPoints: [`${worker}/entry.ts`],
  bundle: true,
  platform: "neutral",
  target: "es2022",
  format: "iife",
  globalName: "surenecoWorker",
  outfile: "dist/php-fcm/worker.js",
});

execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    `${worker}/Cargo.toml`,
    "--target-dir",
    `${worker}/target`,
  ],
  { stdio: "inherit" },
);
