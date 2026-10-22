import { createServer, type IncomingMessage } from "node:http";
import type { Store } from "./store";
import { subscriptions, rateLimit } from "./subscriptions";
import { DeviceAuth, AuthError } from "./device-auth";
import { challenge, confirm, type PushChannel } from "./channels";
const MAX_BODY = 256 * 1024;
export function health(db: Store) {
  const state = db.get<{
    started: number;
    finished: number;
    error: string | null;
  }>("SELECT * FROM service_state WHERE id=1")!;
  const pending = db.get(
    "SELECT COUNT(*) AS count,MIN(created) AS oldestCreatedAt FROM outbox",
  )!;
  return {
    lastStartedAt: state.started,
    lastFinishedAt: state.finished,
    error: state.error,
    outbox: pending,
    monitoringReady: false,
  };
}
export function createApi(db: Store, push: PushChannel | null = null) {
  const auth = new DeviceAuth(db);
  return createServer(
    { maxHeaderSize: 40000, requestTimeout: 10000, headersTimeout: 10000 },
    async (request, response) => {
      const reply = (status: number, body: unknown, allow?: string) => {
        if (response.destroyed) return;
        response.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...(allow ? { Allow: allow } : {}),
        });
        response.end(JSON.stringify(body));
      };
      try {
        const path = request.url?.split("?")[0];
        const methods =
          path === "/healthz" || path === "/v1/push-config"
            ? ["GET"]
            : path === "/v1/subscription"
              ? ["GET", "PUT", "DELETE"]
              : path === "/v1/device"
                ? ["POST", "DELETE"]
                : path === "/v1/device/rotate" ||
                    path === "/v1/subscription/confirm" ||
                    path === "/v1/subscription/stop"
                  ? ["POST"]
                  : null;
        if (!methods) return reply(404, { error: "not_found" });
        if (!methods.includes(request.method ?? ""))
          return reply(
            405,
            { error: "method_not_allowed" },
            methods.join(", "),
          );
        if (path === "/healthz") return reply(200, health(db));
        if (path === "/v1/push-config")
          return push
            ? reply(200, {
                ntfyOrigin: push.origin,
                vapidPublicKey: push.publicKey,
              })
            : reply(503, { error: "push_unavailable" });
        // Listen only on loopback. The deployment proxy must overwrite this header.
        const forwarded = request.headers["x-real-ip"];
        const ip =
          typeof forwarded === "string" && forwarded.length <= 64
            ? forwarded
            : (request.socket.remoteAddress ?? "unknown");
        if (!rateLimit(db, "ip", ip, 120, Date.now()))
          return reply(429, { error: "rate_limited" });
        if (Number(request.headers["content-length"] ?? 0) > MAX_BODY)
          return reply(413, { error: "payload_too_large" });
        const header = (key: string) => {
          const value = request.headers[key];
          return typeof value === "string" ? value : undefined;
        };
        const registering = path === "/v1/device" && request.method === "POST";
        let uid: string | null = null;
        let alreadyDeleted = false;
        if (!registering) {
          try {
            uid = auth.authenticate(header("authorization"));
          } catch (error) {
            if (
              path === "/v1/device" &&
              request.method === "DELETE" &&
              error instanceof AuthError &&
              error.status === 401 &&
              /^Bearer [A-Za-z0-9_-]{43}$/.test(header("authorization") ?? "")
            )
              alreadyDeleted = true;
            else throw error;
          }
        }
        if (uid && !rateLimit(db, "authenticated", uid, 60, Date.now()))
          return reply(429, { error: "rate_limited" });
        const data = await readBody(request);
        let input: unknown = null;
        if (data.length) {
          try {
            input = JSON.parse(data);
          } catch {
            return reply(400, { error: "invalid_json" });
          }
        }
        if (registering) {
          if (
            !input ||
            typeof input !== "object" ||
            Object.keys(input).length !== 1 ||
            (input as { consent?: unknown }).consent !== true
          )
            return reply(400, { error: "consent_required" });
          return reply(201, auth.issue(ip));
        }
        if (alreadyDeleted) {
          if (
            input !== null &&
            (typeof input !== "object" || Object.keys(input).length)
          )
            return reply(400, { error: "invalid_request" });
          return reply(200, { deleted: true });
        }
        if (!uid) throw new AuthError();
        if (path === "/v1/device/rotate") {
          if (
            !input ||
            typeof input !== "object" ||
            Object.keys(input).length !== 1 ||
            typeof (input as { newToken?: unknown }).newToken !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/.test(
              (input as { newToken: string }).newToken,
            )
          )
            return reply(400, { error: "invalid_request" });
          return reply(
            200,
            auth.rotate(uid, (input as { newToken: string }).newToken),
          );
        }
        if (path === "/v1/device") {
          if (
            input !== null &&
            (typeof input !== "object" || Object.keys(input).length)
          )
            return reply(400, { error: "invalid_request" });
          auth.remove(uid);
          return reply(200, { deleted: true });
        }
        const result =
          path === "/v1/subscription/confirm"
            ? await confirm(db, uid, input)
            : await subscriptions(
                db,
                uid,
                request.method!,
                input,
                Date.now(),
                push?.origin,
              );
        if (result.status === 200 && request.method === "PUT" && push) {
          try {
            await challenge(db, uid, push);
          } catch {
            return reply(503, { error: "channel_confirmation_unavailable" });
          }
        }
        reply(result.status, result.body);
      } catch (error) {
        if (error instanceof AuthError)
          return reply(error.status, {
            error:
              error.status === 429
                ? "rate_limited"
                : error.status === 401
                  ? "unauthorized"
                  : "authentication_unavailable",
          });
        if (error instanceof BodyError)
          return reply(error.status, {
            error:
              error.status === 413 ? "payload_too_large" : "request_timeout",
          });
        reply(500, { error: "service_unavailable" });
      }
    },
  );
}
class BodyError extends Error {
  constructor(readonly status: number) {
    super("Request unavailable.");
  }
}
async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) finish(new BodyError(413));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new BodyError(408));
    const timer = setTimeout(() => finish(new BodyError(408)), 5000);
    request.on("data", onData).once("end", onEnd).once("error", onError);
  });
}
