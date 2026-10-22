import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, statSync } from "node:fs";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getAppCheck } from "firebase-admin/app-check";
import { getMessaging } from "firebase-admin/messaging";
import {
  AuthError,
  checkIdentity,
  deliveryFailure,
  messageFor,
  type FirebaseConfig,
} from "./firebase-sdk";
import type { Payload } from "./monitor";
const config = workerData as FirebaseConfig;
let credential;
if (config.credentialsPath) {
  if (statSync(config.credentialsPath).size > 65536)
    throw new Error("Invalid credentials.");
  const json = readFileSync(config.credentialsPath, "utf8");
  if (Buffer.byteLength(json) > 65536) throw new Error("Invalid credentials.");
  const account = JSON.parse(json);
  if (
    account.type !== "service_account" ||
    account.project_id !== config.projectId
  )
    throw new Error("Invalid credentials.");
  credential = cert(account);
}
const app = initializeApp({
  projectId: config.projectId,
  ...(credential ? { credential } : {}),
});
// App Check audiences use the project number; additionally check issuer and app ID.
const checkApp = initializeApp(
  { projectId: config.projectNumber },
  "app-check",
);
parentPort!.on(
  "message",
  async (request: {
    id: number;
    operation: "auth" | "send";
    token: string;
    appCheck?: string;
    payload?: Payload;
  }) => {
    try {
      if (request.operation === "auth") {
        const [identity, checked] = await Promise.all([
          getAuth(app).verifyIdToken(request.token),
          getAppCheck(checkApp).verifyToken(request.appCheck!),
        ]);
        const uid = checkIdentity(config, identity, checked.token);
        parentPort!.postMessage({ id: request.id, ok: true, result: uid });
      } else {
        await getMessaging(app).send(
          messageFor(request.token, request.payload!),
        );
        parentPort!.postMessage({ id: request.id, ok: true });
      }
    } catch (error) {
      if (request.operation === "send") {
        const failure = deliveryFailure(error);
        parentPort!.postMessage({
          id: request.id,
          ok: false,
          code: failure.code,
          retryable: failure.retryable,
          retryAfter: failure.retryAfter,
        });
      } else {
        const code = (error as { code?: string })?.code ?? "";
        const status =
          error instanceof AuthError ||
          /^(auth\/(argument-error|invalid-id-token|id-token-expired|id-token-revoked|user-disabled)|app-check\/(invalid-argument|app-check-token-expired))$/.test(
            code,
          )
            ? 401
            : 503;
        parentPort!.postMessage({ id: request.id, ok: false, status });
      }
    }
  },
);
