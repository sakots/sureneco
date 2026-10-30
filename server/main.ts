import { resolve } from "node:path";
import { Store } from "./store";
import { PushTransport, pushConfig, notificationData } from "./web-push";
import { createApi } from "./api";
import { monitor } from "./monitor";
import { deliver } from "./delivery";
import { Scheduler } from "./scheduler";
import { NtfyAdminClient } from "./ntfy-admin-service";
import { NtfyRegistration } from "./ntfy-registration";
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error();
  const port = Number(process.env.SURENECO_SERVER_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  const config = pushConfig();
  const adminSocket = process.env.SURENECO_NTFY_ADMIN_SOCKET;
  const admin =
    adminSocket === undefined ? null : new NtfyAdminClient(adminSocket);
  if (process.argv.includes("--check-config")) {
    console.log(
      config ? "Push settings loaded; not sent." : "Push not configured.",
    );
    return;
  }
  const transport = config ? new PushTransport(config) : null;
  const db = new Store(
    process.env.SURENECO_SERVER_DB ?? resolve("server/data/monitor.sqlite"),
  );
  const registration = admin ? new NtfyRegistration(db, admin) : null;
  const registrationScheduler = registration
    ? new Scheduler(() => registration.tick())
    : null;
  const api = createApi(
    db,
    transport
      ? {
          origin: transport.config.origin,
          publicKey: transport.config.publicKey,
          send: (...args) => transport.send(...args),
        }
      : null,
    registration,
  );
  const sender = transport
    ? (token: string, payload: import("./monitor").Payload, timeout: number) =>
        transport.send(JSON.parse(token), notificationData(payload), timeout)
    : null;
  const scheduler = new Scheduler(async () => {
    const started = performance.now();
    db.run("UPDATE service_state SET started=? WHERE id=1", Date.now());
    try {
      await monitor(db);
      if (sender)
        await deliver(db, sender, {
          budget: Math.max(0, 50000 - (performance.now() - started)),
        });
      db.run(
        "UPDATE service_state SET finished=?,error=NULL WHERE id=1",
        Date.now(),
      );
    } catch {
      db.run("UPDATE service_state SET error='batch_failed' WHERE id=1");
    }
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      api.once("error", reject);
      api.listen(port, "127.0.0.1", resolveListen);
    });
  } catch {
    db.close();
    throw new Error();
  }
  scheduler.start();
  registrationScheduler?.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), 55000);
    force.unref();
    const closed = new Promise<void>((resolveClose) =>
      api.close(() => resolveClose()),
    );
    api.closeIdleConnections();
    await scheduler.stop();
    await registrationScheduler?.stop();
    await closed;
    db.close();
    clearTimeout(force);
  };
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
  console.log("sureneco server ready.");
}
main().catch(() => {
  console.error("Server startup failed.");
  process.exitCode = 1;
});
