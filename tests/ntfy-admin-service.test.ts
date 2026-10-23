import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createNtfyAdminService,
  NtfyAdminClient,
} from "../server/ntfy-admin-service";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function socketPath() {
  const dir = mkdtempSync(join(tmpdir(), "sureneco-ntfy-socket-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "admin.sock");
}
function close(server: Server) {
  cleanup.push(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    return promise;
  });
}
function admin() {
  return {
    ensureAccount: vi.fn(async (_uid: string, _password: string) => {}),
    grantRead: vi.fn(async (_uid: string, _topic: string) => {}),
    revokeRead: vi.fn(async (_uid: string, _topic: string) => {}),
    removeAccount: vi.fn(async (_uid: string) => {}),
  };
}
async function raw(path: string, data: string, end = true) {
  const socket = createConnection(path);
  socket.on("error", () => {});
  await once(socket, "connect");
  let result = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    result += chunk;
  });
  const closed = once(socket, "close");
  if (end) socket.end(data);
  else socket.write(data);
  await closed;
  return result;
}
it("transports only the four constrained operations through a group-only Unix socket", async () => {
  const path = socketPath();
  const port = admin();
  close(await createNtfyAdminService(path, port));
  expect(statSync(path).mode & 0o777).toBe(0o660);
  const client = new NtfyAdminClient(path);
  const uid = randomUUID();
  const password = randomBytes(32).toString("base64url");
  await client.ensureAccount(uid, password);
  await client.grantRead(uid, "upone");
  await client.revokeRead(uid, "upone");
  await client.removeAccount(uid);
  expect(port.ensureAccount).toHaveBeenCalledExactlyOnceWith(uid, password);
  expect(port.grantRead).toHaveBeenCalledExactlyOnceWith(uid, "upone");
  expect(port.revokeRead).toHaveBeenCalledExactlyOnceWith(uid, "upone");
  expect(port.removeAccount).toHaveBeenCalledExactlyOnceWith(uid);
});
it("rejects malformed, oversized, unknown and multi-request messages before invoking admin", async () => {
  const path = socketPath();
  const port = admin();
  close(await createNtfyAdminService(path, port));
  const uid = randomUUID();
  const valid = { operation: "grantRead", uid, topic: "upone" };
  for (const data of [
    "{",
    "null",
    "[]",
    "x".repeat(4097),
    JSON.stringify({ ...valid, operation: "exec" }),
    JSON.stringify({ ...valid, extra: "--role=admin" }),
    JSON.stringify({ ...valid, uid: "admin" }),
    JSON.stringify({ ...valid, topic: "*" }),
    JSON.stringify({ ...valid, topic: "https://push.example/upone" }),
    JSON.stringify({
      operation: "ensureAccount",
      uid,
      password: "not-a-password",
    }),
    JSON.stringify({ operation: "removeAccount", uid, topic: "upone" }),
    JSON.stringify(valid) + "\n" + JSON.stringify(valid),
  ]) {
    expect(await raw(path, data)).toContain("invalid_ntfy_request");
  }
  for (const operation of Object.values(port))
    expect(operation).not.toHaveBeenCalled();
});
it("bounds incomplete reads and operations and hides raw admin errors", async () => {
  const path = socketPath();
  const port = admin();
  port.removeAccount.mockRejectedValueOnce(
    new Error("secret CLI stderr password"),
  );
  port.removeAccount.mockImplementationOnce(
    () => Promise.withResolvers<void>().promise,
  );
  close(
    await createNtfyAdminService(path, port, {
      readTimeoutMs: 30,
      operationTimeoutMs: 30,
    }),
  );
  expect(await raw(path, "{", false)).toContain("invalid_ntfy_request");
  const client = new NtfyAdminClient(path);
  await expect(client.removeAccount(randomUUID())).rejects.toThrow(
    "ntfy_admin_failed",
  );
  const response = await raw(
    path,
    JSON.stringify({ operation: "removeAccount", uid: randomUUID() }),
  );
  expect(JSON.parse(response)).toEqual({ error: "ntfy_admin_failed" });
  expect(response).not.toContain("secret");
});
it("bounds client waits and response size and never replaces preexisting paths", async () => {
  expect(() => new NtfyAdminClient("relative.sock")).toThrow();
  const path = socketPath();
  writeFileSync(path, "operator-owned");
  await expect(createNtfyAdminService(path, admin())).rejects.toThrow();
  expect(readFileSync(path, "utf8")).toBe("operator-owned");
  const hangingPath = socketPath();
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("data", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(hangingPath);
  await once(server, "listening");
  cleanup.push(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
    return promise;
  });
  await expect(
    new NtfyAdminClient(hangingPath, { timeoutMs: 30 }).removeAccount(
      randomUUID(),
    ),
  ).rejects.toThrow("ntfy_admin_failed");
  server.removeAllListeners("connection");
  server.on("connection", (socket) => {
    socket.on("error", () => {});
    socket.on("data", () => {});
    socket.end("x".repeat(4097));
  });
  await expect(
    new NtfyAdminClient(hangingPath).removeAccount(randomUUID()),
  ).rejects.toThrow("ntfy_admin_failed");
});
