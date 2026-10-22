import webpush, { type PushSubscription } from "web-push";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, BlockList } from "node:net";
import { ECDH, createECDH } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DeliveryError } from "./delivery";
export interface PushConfig {
  origin: string;
  subject: string;
  publicKey: string;
  privateKey: string;
}
export type PushData = { expiresAt: number; [key: string]: unknown };
function base64(value: unknown, length: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid push subscription.");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value)
    throw new Error("Invalid push subscription.");
  return bytes;
}
export function parsePushSubscription(
  input: unknown,
  origin: string,
): PushSubscription {
  if (!input || typeof input !== "object")
    throw new Error("Invalid push subscription.");
  const v = input as Record<string, unknown>;
  const keys = v.keys as Record<string, unknown> | undefined;
  if (
    Object.keys(v).some((k) => !["endpoint", "keys"].includes(k)) ||
    !keys ||
    Object.keys(keys).some((k) => !["p256dh", "auth"].includes(k)) ||
    typeof v.endpoint !== "string" ||
    v.endpoint.length > 2048
  )
    throw new Error("Invalid push subscription.");
  const url = new URL(v.endpoint);
  if (
    url.origin !== origin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.search && url.search !== "?up=1") ||
    url.hash ||
    !/^\/up[A-Za-z0-9_-]{1,62}$/.test(url.pathname) ||
    url.href !== v.endpoint
  )
    throw new Error("Invalid push subscription.");
  const pub = base64(keys.p256dh, 65);
  base64(keys.auth, 16);
  ECDH.convertKey(pub, "prime256v1");
  url.search = "";
  return {
    endpoint: url.href,
    keys: { p256dh: keys.p256dh as string, auth: keys.auth as string },
  };
}
const nonPublic = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  nonPublic.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  nonPublic.addSubnet(ip, bits, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
export function publicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 6)
    return globalV6.check(ip, "ipv6") && !nonPublic.check(ip, "ipv6");
  return family === 4 && !nonPublic.check(ip, "ipv4");
}
export function pushConfig(
  env: NodeJS.ProcessEnv = process.env,
): PushConfig | null {
  const origin = env.SURENECO_NTFY_ORIGIN;
  const path = env.SURENECO_VAPID_FILE;
  if (!origin && !path) return null;
  try {
    if (
      !origin ||
      new URL(origin).origin !== origin ||
      !origin.startsWith("https://") ||
      !path ||
      !isAbsolute(path) ||
      statSync(path).size > 4096
    )
      throw new Error();
    const value = JSON.parse(readFileSync(path, "utf8"));
    const privateKey = base64(value.privateKey, 32);
    const key = createECDH("prime256v1");
    key.setPrivateKey(privateKey);
    if (
      key.getPublicKey().toString("base64url") !== value.publicKey ||
      typeof value.subject !== "string" ||
      !/^mailto:[^\s@]+@[^\s@]+$/.test(value.subject)
    )
      throw new Error();
    return {
      origin,
      subject: value.subject,
      publicKey: value.publicKey,
      privateKey: value.privateKey,
    };
  } catch {
    throw new Error("Push configuration unavailable.");
  }
}
export class PushTransport {
  constructor(
    readonly config: PushConfig,
    private readonly resolve: (
      host: string,
    ) => Promise<{ address: string; family: number }[]> = (host) =>
      lookup(host, { all: true, verbatim: true }),
  ) {}
  message(input: PushSubscription, data: PushData) {
    const sub = parsePushSubscription(input, this.config.origin);
    const ttl = Math.floor(data.expiresAt - Date.now() / 1000);
    if (ttl <= 0) throw new DeliveryError("expired", false);
    const body = JSON.stringify(data);
    if (Buffer.byteLength(body) > 2500)
      throw new DeliveryError("invalid_payload", false);
    const details = webpush.generateRequestDetails(sub, body, {
      TTL: Math.min(ttl, 86400),
      contentEncoding: "aes128gcm",
      vapidDetails: {
        subject: this.config.subject,
        publicKey: this.config.publicKey,
        privateKey: this.config.privateKey,
      },
    });
    details.headers["X-UnifiedPush"] = "1";
    return details;
  }
  async send(
    input: PushSubscription,
    data: PushData,
    timeout: number,
  ): Promise<void> {
    const details = this.message(input, data);
    const url = new URL(details.endpoint);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let expired = false;
    try {
      await Promise.race([
        (async () => {
          const addresses = await this.resolve(url.hostname);
          if (expired) throw new DeliveryError("delivery_timeout");
          if (
            !addresses.length ||
            addresses.some((x) => !publicAddress(x.address))
          )
            throw new DeliveryError("invalid_destination", false);
          const address = addresses[0];
          await new Promise<void>((done, fail) => {
            const req = request(
              url,
              {
                method: "POST",
                headers: details.headers,
                lookup: (_host, options, cb) => {
                  if (options.all) cb(null, [address]);
                  else cb(null, address.address, address.family);
                },
              },
              (res) => {
                res.resume();
                const code = res.statusCode ?? 0;
                if (code >= 200 && code < 300) done();
                else {
                  const retry = Number(res.headers["retry-after"]);
                  fail(
                    new DeliveryError(
                      code === 410
                        ? "invalid_endpoint"
                        : code === 429
                          ? "rate_limited"
                          : code === 401 || code === 403
                            ? "push_unauthorized"
                            : "push_unavailable",
                      code === 429 || code >= 500,
                      Number.isFinite(retry)
                        ? Math.max(0, Math.min(retry, 86400))
                        : 0,
                    ),
                  );
                }
              },
            );
            abort = () => req.destroy(new Error("timeout"));
            req.once("error", () =>
              fail(new DeliveryError("push_unavailable")),
            );
            req.end(details.body);
          });
        })(),
        new Promise<never>((_, fail) => {
          timer = setTimeout(
            () => {
              expired = true;
              abort?.();
              fail(new DeliveryError("delivery_timeout"));
            },
            Math.max(1, Math.min(5000, timeout)),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      abort?.();
    }
  }
}
