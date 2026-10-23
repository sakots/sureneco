import { chmodSync, lstatSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { isAbsolute } from "node:path";
import type { NtfyAdminPort } from "./ntfy-registration";

const MAX_MESSAGE = 4096;
type AdminRequest =
  | { operation: "ensureAccount"; uid: string; password: string }
  | { operation: "grantRead" | "revokeRead"; uid: string; topic: string }
  | { operation: "removeAccount"; uid: string };

function socketPath(path: string): string {
  if (
    !isAbsolute(path) ||
    Buffer.byteLength(path) > 107 ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    throw new Error("invalid_ntfy_socket");
  return path;
}
function timeout(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum)
    throw new Error("invalid_ntfy_timeout");
  return result;
}
function parseRequest(data: string): AdminRequest {
  const input: unknown = JSON.parse(data);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error();
  const value = input as Record<string, unknown>;
  if (
    typeof value.uid !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.uid,
    )
  )
    throw new Error();
  let fields: string[];
  switch (value.operation) {
    case "ensureAccount":
      fields = ["operation", "uid", "password"];
      if (
        typeof value.password !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.password) ||
        Buffer.from(value.password, "base64url").toString("base64url") !==
          value.password
      )
        throw new Error();
      break;
    case "grantRead":
    case "revokeRead":
      fields = ["operation", "uid", "topic"];
      if (
        typeof value.topic !== "string" ||
        !/^up[A-Za-z0-9_-]{1,62}$/.test(value.topic)
      )
        throw new Error();
      break;
    case "removeAccount":
      fields = ["operation", "uid"];
      break;
    default:
      throw new Error();
  }
  if (
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error();
  return value as AdminRequest;
}
async function invoke(
  admin: NtfyAdminPort,
  request: AdminRequest,
  timeoutMs: number,
) {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new Error("ntfy_admin_failed")),
    timeoutMs,
  );
  try {
    let operation: Promise<void>;
    switch (request.operation) {
      case "ensureAccount":
        operation = admin.ensureAccount(request.uid, request.password);
        break;
      case "grantRead":
        operation = admin.grantRead(request.uid, request.topic);
        break;
      case "revokeRead":
        operation = admin.revokeRead(request.uid, request.topic);
        break;
      case "removeAccount":
        operation = admin.removeAccount(request.uid);
        break;
    }
    await Promise.race([operation, promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** One EOF-delimited JSON request per local connection; no arbitrary CLI arguments. */
export async function createNtfyAdminService(
  path: string,
  admin: NtfyAdminPort,
  options: { readTimeoutMs?: number; operationTimeoutMs?: number } = {},
): Promise<Server> {
  socketPath(path);
  const readTimeout = timeout(options.readTimeoutMs, 1000, 1000);
  const operationTimeout = timeout(options.operationTimeoutMs, 5500, 6000);
  if (lstatSync(path, { throwIfNoEntry: false }))
    throw new Error("ntfy_admin_socket_unavailable");
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let completed = false;
    const reply = (body: { ok: true } | { error: string }) => {
      if (!socket.destroyed)
        socket.end(JSON.stringify(body) + "\n", () => socket.destroy());
    };
    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      socket.resume();
      reply({ error: "invalid_ntfy_request" });
    }, readTimeout);
    socket.on("error", () => {});
    socket.once("close", () => clearTimeout(timer));
    socket.on("data", (chunk: Buffer) => {
      if (completed) return;
      size += chunk.length;
      if (size > MAX_MESSAGE) {
        completed = true;
        clearTimeout(timer);
        reply({ error: "invalid_ntfy_request" });
      } else chunks.push(chunk);
    });
    socket.once("end", () => {
      clearTimeout(timer);
      if (completed) return;
      completed = true;
      let request: AdminRequest;
      try {
        request = parseRequest(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reply({ error: "invalid_ntfy_request" });
        return;
      }
      void invoke(admin, request, operationTimeout).then(
        () => reply({ ok: true }),
        () => reply({ error: "ntfy_admin_failed" }),
      );
    });
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  // Socket creation itself must already exclude other users, before chmod/listening.
  const previousMask = process.umask(0o117);
  try {
    server.listen(path, () => {
      try {
        chmodSync(path, 0o660);
        resolve();
      } catch {
        server.close();
        reject(new Error("ntfy_admin_socket_unavailable"));
      }
    });
  } finally {
    process.umask(previousMask);
  }
  try {
    await promise;
  } catch {
    throw new Error("ntfy_admin_socket_unavailable");
  }
  server.removeListener("error", reject);
  return server;
}

export class NtfyAdminClient implements NtfyAdminPort {
  private readonly path: string;
  private readonly timeoutMs: number;
  constructor(path: string, options: { timeoutMs?: number } = {}) {
    this.path = socketPath(path);
    this.timeoutMs = timeout(options.timeoutMs, 6500, 7000);
  }
  ensureAccount(uid: string, password: string): Promise<void> {
    return this.request({ operation: "ensureAccount", uid, password });
  }
  grantRead(uid: string, topic: string): Promise<void> {
    return this.request({ operation: "grantRead", uid, topic });
  }
  revokeRead(uid: string, topic: string): Promise<void> {
    return this.request({ operation: "revokeRead", uid, topic });
  }
  removeAccount(uid: string): Promise<void> {
    return this.request({ operation: "removeAccount", uid });
  }
  private request(request: AdminRequest): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = createConnection(this.path);
    const chunks: Buffer[] = [];
    let size = 0;
    let completed = false;
    const finish = (success = false) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      socket.destroy();
      if (success) resolve();
      else reject(new Error("ntfy_admin_failed"));
    };
    const timer = setTimeout(() => finish(), this.timeoutMs);
    socket.once("connect", () => socket.end(JSON.stringify(request)));
    socket.on("error", () => finish());
    socket.once("close", () => finish());
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MESSAGE) finish();
      else chunks.push(chunk);
    });
    socket.once("end", () => {
      try {
        const response: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        finish(
          !!response &&
            typeof response === "object" &&
            !Array.isArray(response) &&
            Object.keys(response).length === 1 &&
            "ok" in response &&
            response.ok === true,
        );
      } catch {
        finish();
      }
    });
    return promise;
  }
}
