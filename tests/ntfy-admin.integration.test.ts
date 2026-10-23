import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createNtfyCredentials, NtfyAdmin } from "../server/ntfy-admin";

const binary = process.env.SURENECO_TEST_NTFY_BIN;

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

it.skipIf(!binary)(
  "real ntfy isolates two device users, denies writes and revokes access/account idempotently",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "sureneco-ntfy-admin-"));
    let child: ChildProcess | undefined;
    try {
      const listener = createServer();
      listener.listen(0, "127.0.0.1");
      await once(listener, "listening");
      const address = listener.address();
      if (!address || typeof address === "string")
        throw new Error("No test port");
      await new Promise<void>((resolve, reject) =>
        listener.close((e) => (e ? reject(e) : resolve())),
      );
      const base = `http://127.0.0.1:${address.port}`;
      const config = join(directory, "server.yml");
      writeFileSync(
        config,
        [
          `base-url: ${base}`,
          `listen-http: 127.0.0.1:${address.port}`,
          `auth-file: ${join(directory, "user.db")}`,
          "auth-default-access: deny-all",
          "auth-access:",
          '  - "*:up*:write-only"',
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      child = spawn(binary!, ["serve", "--config", config], {
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
      });
      let spawnError: Error | undefined;
      child.on("error", (error) => {
        spawnError = error;
      });
      const deadline = Date.now() + 5000;
      while (true) {
        if (spawnError) throw spawnError;
        if (Date.now() >= deadline) throw new Error("Test ntfy did not start");
        try {
          const response = await fetch(base + "/v1/health", {
            signal: AbortSignal.timeout(500),
          });
          if (response.ok) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const admin = new NtfyAdmin({ binary: binary!, config });
      const uid = "11111111-1111-4111-8111-111111111111";
      const otherUid = "22222222-2222-4222-8222-222222222222";
      const first = createNtfyCredentials(uid);
      const other = createNtfyCredentials(otherUid);
      await admin.ensureAccount(uid, first.password);
      await admin.ensureAccount(otherUid, other.password);
      await admin.ensureAccount(uid, createNtfyCredentials(uid).password);
      const headers = (user: typeof first) => ({
        Authorization:
          "Basic " +
          Buffer.from(`${user.username}:${user.password}`).toString("base64"),
      });
      const read = async (user: typeof first, topic = "upFirst") =>
        (
          await fetch(`${base}/${topic}/json?poll=1`, {
            headers: headers(user),
            signal: AbortSignal.timeout(2000),
          })
        ).status;
      expect(await read(first)).toBe(403);
      await admin.grantRead(uid, "upFirst");
      await admin.grantRead(uid, "upFirst");
      await admin.grantRead(otherUid, "upOther");
      expect(await read(first)).toBe(200);
      expect(await read(other)).toBe(403);
      expect(await read(first, "upOther")).toBe(403);
      expect(
        (
          await fetch(base + "/upFirst", {
            method: "POST",
            headers: headers(first),
            body: "test",
            signal: AbortSignal.timeout(2000),
          })
        ).status,
      ).toBe(403);
      await admin.revokeRead(uid, "upFirst");
      await admin.revokeRead(uid, "upFirst");
      expect(await read(first)).toBe(403);
      await admin.grantRead(uid, "upFirst");
      expect(await read(first)).toBe(200);
      await admin.removeAccount(uid);
      await admin.removeAccount(uid);
      expect(await read(first)).toBe(401);
      expect(await read(other, "upOther")).toBe(200);
    } finally {
      if (child) await stop(child);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30000,
);
