import { spawn } from "node:child_process";
import { createServer } from "vite";
import { build } from "esbuild";
import electron from "electron";
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
const server = await createServer({
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
await server.listen();
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, SURENECO_DEV_URL: "http://127.0.0.1:5173" },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
