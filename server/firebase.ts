import { Worker } from "node:worker_threads";
import { resolve, isAbsolute } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { AuthError, type FirebaseConfig } from "./firebase-sdk";
import { DeliveryError, type Sender } from "./delivery";
export function firebaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): FirebaseConfig | null {
  const projectId = env.SURENECO_FIREBASE_PROJECT_ID;
  const projectNumber = env.SURENECO_FIREBASE_PROJECT_NUMBER;
  const appId = env.SURENECO_FIREBASE_APP_ID;
  if (!projectId && !projectNumber && !appId && !env.SURENECO_FCM_CREDENTIALS)
    return null;
  if (
    !projectId ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ||
    !projectNumber ||
    !/^\d+$/.test(projectNumber) ||
    !appId ||
    !appId.startsWith(`1:${projectNumber}:android:`) ||
    !/^1:\d+:android:[a-f0-9]+$/i.test(appId)
  )
    throw new Error("Firebase configuration unavailable.");
  const credentialsPath = env.SURENECO_FCM_CREDENTIALS || undefined;
  if (credentialsPath) {
    try {
      if (
        !isAbsolute(credentialsPath) ||
        statSync(credentialsPath).size > 65536
      )
        throw new Error();
      const text = readFileSync(credentialsPath, "utf8");
      if (Buffer.byteLength(text) > 65536) throw new Error();
      const value = JSON.parse(text);
      if (
        value.type !== "service_account" ||
        value.project_id !== projectId ||
        typeof value.private_key !== "string" ||
        typeof value.client_email !== "string"
      )
        throw new Error();
      const key = createPrivateKey(value.private_key);
      if (
        key.asymmetricKeyType !== "rsa" ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new Error();
    } catch {
      throw new Error("Firebase configuration unavailable.");
    }
  }
  return { projectId, projectNumber, appId, credentialsPath };
}
interface Answer {
  id: number;
  ok: boolean;
  result?: string;
  status?: number;
  code?: string;
  retryable?: boolean;
  retryAfter?: number;
}
export class Firebase {
  private worker?: Worker;
  private next = 0;
  private pending = new Map<
    number,
    {
      finish: (value: Answer) => void;
      fail: () => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(readonly config: FirebaseConfig | null) {}
  private async request(input: object, timeout: number): Promise<Answer> {
    if (!this.config || this.pending.size >= 8) throw new AuthError(503);
    if (!this.worker) {
      this.worker = new Worker(resolve("dist/server/firebase-worker.mjs"), {
        workerData: this.config,
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        stdout: true,
        stderr: true,
      });
      this.worker.on("message", (answer: Answer) => {
        const item = this.pending.get(answer.id);
        if (!item) return;
        clearTimeout(item.timer);
        this.pending.delete(answer.id);
        item.finish(answer);
      });
      this.worker.once("error", () => {
        void this.close();
      });
      this.worker.once("exit", () => {
        void this.close();
      });
    }
    const id = ++this.next;
    return new Promise((finish, reject) => {
      const timer = setTimeout(
        () => {
          void this.close();
        },
        Math.max(1, Math.min(5000, timeout)),
      );
      this.pending.set(id, {
        finish,
        fail: () => reject(new AuthError(503)),
        timer,
      });
      this.worker!.postMessage({ ...input, id });
    });
  }
  async authenticate(
    authorization: string | undefined,
    appCheck: string | undefined,
  ): Promise<string> {
    if (!this.config) throw new AuthError(503);
    const match = authorization?.match(/^Bearer ([\x21-\x7e]{1,16384})$/);
    if (!match || !appCheck || !/^[\x21-\x7e]{1,16384}$/.test(appCheck))
      throw new AuthError();
    const answer = await this.request(
      { operation: "auth", token: match[1], appCheck },
      5000,
    );
    if (!answer.ok || !answer.result) throw new AuthError(answer.status ?? 503);
    return answer.result;
  }
  sender(): Sender | null {
    if (!this.config?.credentialsPath) return null;
    return async (token, payload, timeout) => {
      let answer: Answer;
      try {
        answer = await this.request(
          { operation: "send", token, payload },
          timeout,
        );
      } catch {
        throw new DeliveryError("delivery_timeout");
      }
      if (!answer.ok)
        throw new DeliveryError(
          answer.code ?? "delivery_unavailable",
          answer.retryable,
          answer.retryAfter,
        );
    };
  }
  async close() {
    const worker = this.worker;
    this.worker = undefined;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.fail();
    }
    this.pending.clear();
    worker?.removeAllListeners();
    await worker?.terminate();
  }
}
