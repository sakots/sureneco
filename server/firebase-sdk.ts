import type { Message } from "firebase-admin/messaging";
import { DeliveryError } from "./delivery";
import type { Payload } from "./monitor";
export interface FirebaseConfig {
  projectId: string;
  projectNumber: string;
  appId: string;
  credentialsPath?: string;
}
export class AuthError extends Error {
  constructor(readonly status = 401) {
    super("Authentication unavailable.");
  }
}
export function checkIdentity(
  config: FirebaseConfig,
  id: { uid: string; aud: string; iss: string; exp: number; iat: number },
  app: { app_id: string; iss: string; aud: string[]; exp: number; iat: number },
  now = Date.now(),
): string {
  const seconds = now / 1000;
  if (
    !id.uid ||
    id.uid.length > 128 ||
    /[\x00-\x1f\x7f]/.test(id.uid) ||
    id.aud !== config.projectId ||
    id.iss !== `https://securetoken.google.com/${config.projectId}` ||
    id.exp <= seconds ||
    id.iat > seconds ||
    app.app_id !== config.appId ||
    app.iss !==
      `https://firebaseappcheck.googleapis.com/${config.projectNumber}` ||
    !app.aud.includes(`projects/${config.projectNumber}`) ||
    app.exp <= seconds ||
    app.iat > seconds
  )
    throw new AuthError();
  return id.uid;
}
function truncate(value: string, bytes: number) {
  let result = "";
  let size = 0;
  for (const char of value) {
    size += Buffer.byteLength(char);
    if (size > bytes) break;
    result += char;
  }
  return result;
}
export function messageFor(
  token: string,
  payload: Payload,
  now = Date.now(),
): Message {
  const ttl = Math.min(2419200000, payload.expiresAt * 1000 - now);
  if (ttl <= 0) throw new DeliveryError("expired", false);
  const data = {
    eventId: payload.eventId,
    revision: String(payload.revision),
    expiresAt: String(payload.expiresAt),
    boardUrl: payload.boardUrl,
    threadId: payload.threadId,
    postNumber: String(payload.recruitment.number),
    roomIds: JSON.stringify(payload.recruitment.roomIds.slice(0, 20)),
    title: truncate(payload.threadTitle, 240),
    body: truncate(payload.recruitment.body, 1500),
  };
  if (
    Object.entries(data).reduce(
      (n, [key, value]) =>
        n + Buffer.byteLength(key) + Buffer.byteLength(value),
      0,
    ) > 3500
  )
    throw new DeliveryError("invalid_payload", false);
  return {
    token,
    data,
    android: {
      priority: "high",
      ttl,
      restrictedPackageName: "sureneco.sakots",
    },
  };
}
export function deliveryFailure(
  error: unknown,
  now = Date.now(),
): DeliveryError {
  if (error instanceof DeliveryError) return error;
  const value = error as {
    code?: string;
    httpResponse?: { headers?: Record<string, string> };
  } | null;
  const header = value?.httpResponse?.headers?.["retry-after"];
  const retry = header
    ? /^\d+$/.test(header)
      ? Number(header)
      : Math.ceil((Date.parse(header) - now) / 1000)
    : 0;
  const retryAfter = Number.isFinite(retry)
    ? Math.max(0, Math.min(2419200, retry))
    : 0;
  if (value?.code === "messaging/registration-token-not-registered")
    return new DeliveryError("unregistered", false);
  if (
    [
      "messaging/invalid-argument",
      "messaging/invalid-registration-token",
      "messaging/mismatched-credential",
    ].includes(value?.code ?? "")
  )
    return new DeliveryError("invalid_argument", false);
  return new DeliveryError("delivery_unavailable", true, retryAfter);
}
