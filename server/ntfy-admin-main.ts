import { NtfyAdmin } from "./ntfy-admin";
import { createNtfyAdminService } from "./ntfy-admin-service";

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error();
  const socket = process.env.SURENECO_NTFY_ADMIN_SOCKET;
  const binary = process.env.SURENECO_NTFY_BIN;
  const config = process.env.SURENECO_NTFY_CONFIG;
  if (!socket || !binary || !config) throw new Error();
  const server = await createNtfyAdminService(
    socket,
    new NtfyAdmin({ binary, config }),
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    server.close(() => clearTimeout(force));
  };
  server.on("error", () => {
    console.error("ntfy management service failed.");
    process.exitCode = 1;
    stop();
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.log("ntfy management service ready.");
}
main().catch(() => {
  console.error("ntfy management startup failed.");
  process.exitCode = 1;
});
