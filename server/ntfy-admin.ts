import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";

export interface NtfyCommand {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}
interface Options {
  binary: string;
  config: string;
  timeoutMs?: number;
}
type Runner = (command: NtfyCommand) => Promise<void>;

function invalid(): never {
  throw new Error("invalid_ntfy_input");
}
function username(deviceId: string): string {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      deviceId,
    )
  )
    invalid();
  return "sur_" + deviceId.replaceAll("-", "");
}
function topicName(topic: string): string {
  if (!/^up[A-Za-z0-9_-]{1,62}$/.test(topic)) invalid();
  return topic;
}
export function createNtfyCredentials(deviceId: string) {
  return {
    username: username(deviceId),
    password: randomBytes(32).toString("base64url"),
  };
}

const execute: Runner = ({ binary, args, env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      {
        env,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      },
      (error, _stdout, stderr) => {
        if (!error) resolve();
        else reject({ code: error.code, signal: error.signal, stderr });
      },
    );
    child.stdin?.end();
  });

/** Trusted server-side admin component. Never expose raw arguments through an API. */
export class NtfyAdmin {
  private readonly timeoutMs: number;
  constructor(
    private readonly options: Options,
    private readonly run: Runner = execute,
  ) {
    for (const path of [options.binary, options.config])
      if (!isAbsolute(path) || path.length > 4096 || /[\x00\r\n]/.test(path))
        invalid();
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 5000
    )
      invalid();
  }
  async ensureAccount(deviceId: string, password: string): Promise<void> {
    const user = username(deviceId);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(password) ||
      Buffer.from(password, "base64url").toString("base64url") !== password
    )
      invalid();
    await this.invoke(
      "user",
      ["add", "--role=user", "--ignore-exists", user],
      password,
    );
  }
  async grantRead(deviceId: string, topic: string): Promise<void> {
    await this.invoke("access", [
      username(deviceId),
      topicName(topic),
      "read-only",
    ]);
  }
  async revokeRead(deviceId: string, topic: string): Promise<void> {
    await this.invoke("access", [
      "--reset",
      username(deviceId),
      topicName(topic),
    ]);
  }
  async removeAccount(deviceId: string): Promise<void> {
    const user = username(deviceId);
    await this.invoke("user", ["remove", user], undefined, user);
  }
  private async invoke(
    command: "user" | "access",
    args: string[],
    password?: string,
    deleting?: string,
  ): Promise<void> {
    try {
      await this.run({
        binary: this.options.binary,
        args: [command, "--config", this.options.config, ...args],
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
          ...(password ? { NTFY_PASSWORD: password } : {}),
        },
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      // ntfy 2.32.0 returns code 1 for an already absent user. Do not hide
      // config/DB errors, timeouts, killed commands or unexpected output.
      if (
        deleting &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === 1 &&
        !("signal" in error && error.signal) &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.trim() === `user ${deleting} does not exist`
      )
        return;
      throw new Error("ntfy_admin_failed");
    }
  }
}
