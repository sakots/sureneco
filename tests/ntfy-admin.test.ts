import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createNtfyCredentials,
  NtfyAdmin,
  type NtfyCommand,
} from "../server/ntfy-admin";

const uid = "11111111-1111-4111-8111-111111111111";
const username = "sur_11111111111141118111111111111111";
const password = () => randomBytes(32).toString("base64url");
const setup = () => {
  const run = vi.fn(async (_command: NtfyCommand) => {});
  const admin = new NtfyAdmin(
    { binary: "/usr/bin/ntfy", config: "/etc/ntfy/server.yml" },
    run,
  );
  return { admin, run };
};

it
  .skipIf(process.platform === "win32")
  .each([
    "setInterval(() => {}, 1000)",
    'process.stderr.write("private-output".repeat(20000)); setInterval(() => {}, 1000)',
  ])("bounds and sanitizes a real child process (%#)", async (body) => {
  const directory = mkdtempSync(join(tmpdir(), "sureneco-ntfy-command-"));
  try {
    const binary = join(directory, "ntfy-fixture");
    writeFileSync(binary, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
    const admin = new NtfyAdmin({
      binary,
      config: join(directory, "server.yml"),
      timeoutMs: 300,
    });
    await expect(admin.ensureAccount(uid, password())).rejects.toThrow(
      /^ntfy_admin_failed$/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("generates per-device credentials without accepting arbitrary ntfy usernames", () => {
  const first = createNtfyCredentials(uid);
  const next = createNtfyCredentials(uid);
  expect(first.username).toBe(username);
  expect(first.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(next.password).not.toBe(first.password);
  for (const id of ["admin", "device001", "*", "--role=admin", uid + "\n"])
    expect(() => createNtfyCredentials(id)).toThrow("invalid_ntfy_input");
});

it("creates only a regular namespaced user and passes the password outside argv", async () => {
  const { admin, run } = setup();
  const secret = password();
  vi.stubEnv("NTFY_PASSWORD_HASH", "must-not-inherit");
  vi.stubEnv("NTFY_AUTH_FILE", "/unrelated/user.db");
  try {
    await admin.ensureAccount(uid, secret);
    const command = run.mock.calls[0][0];
    expect(command.args).toEqual([
      "user",
      "--config",
      "/etc/ntfy/server.yml",
      "add",
      "--role=user",
      "--ignore-exists",
      username,
    ]);
    expect(command.args.join(" ")).not.toContain(secret);
    expect(command.env.NTFY_PASSWORD).toBe(secret);
    expect(command.env.NTFY_PASSWORD_HASH).toBeUndefined();
    expect(command.env.NTFY_AUTH_FILE).toBeUndefined();
    expect(command.timeoutMs).toBe(5000);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("grants and revokes only a concrete UnifiedPush topic for the derived user", async () => {
  const { admin, run } = setup();
  await admin.grantRead(uid, "upAbc_123");
  await admin.revokeRead(uid, "upAbc_123");
  expect(run.mock.calls.map(([c]) => c.args)).toEqual([
    [
      "access",
      "--config",
      "/etc/ntfy/server.yml",
      username,
      "upAbc_123",
      "read-only",
    ],
    [
      "access",
      "--config",
      "/etc/ntfy/server.yml",
      "--reset",
      username,
      "upAbc_123",
    ],
  ]);
  expect(run.mock.calls[0][0].env.NTFY_PASSWORD).toBeUndefined();
});

it("rejects broad permissions, shell fragments and invalid secrets before executing", async () => {
  const { admin, run } = setup();
  for (const topic of [
    "",
    "*",
    "up*",
    "up",
    "upA\n",
    "upA;id",
    "../upA",
    "https://push.example/upA",
    "up" + "a".repeat(63),
  ]) {
    await expect(admin.grantRead(uid, topic)).rejects.toThrow(
      "invalid_ntfy_input",
    );
    await expect(admin.revokeRead(uid, topic)).rejects.toThrow(
      "invalid_ntfy_input",
    );
  }
  await expect(admin.ensureAccount("admin", password())).rejects.toThrow(
    "invalid_ntfy_input",
  );
  await expect(admin.removeAccount("device001")).rejects.toThrow(
    "invalid_ntfy_input",
  );
  await expect(admin.ensureAccount(uid, "short")).rejects.toThrow(
    "invalid_ntfy_input",
  );
  expect(run).not.toHaveBeenCalled();
});

it("requires fixed absolute binary/config paths and a bounded timeout", () => {
  for (const options of [
    { binary: "ntfy", config: "/etc/ntfy/server.yml" },
    { binary: "/usr/bin/ntfy", config: "server.yml" },
    { binary: "/usr/bin/ntfy", config: "/etc/ntfy/server.yml\n" },
    { binary: "/usr/bin/ntfy", config: "/etc/ntfy/server.yml", timeoutMs: 0 },
    {
      binary: "/usr/bin/ntfy",
      config: "/etc/ntfy/server.yml",
      timeoutMs: 5001,
    },
  ])
    expect(() => new NtfyAdmin(options)).toThrow("invalid_ntfy_input");
});

it("sanitizes CLI failures and treats only a proven absent managed user as removed", async () => {
  const run = vi.fn(async (_command: NtfyCommand) => {
    throw { code: 1, stderr: `user ${username} does not exist\n` };
  });
  const admin = new NtfyAdmin(
    { binary: "/usr/bin/ntfy", config: "/private/server.yml" },
    run,
  );
  await expect(admin.removeAccount(uid)).resolves.toBeUndefined();
  run.mockImplementation(async () => {
    throw {
      code: 1,
      stderr: "private password, endpoint and user database details",
    };
  });
  await expect(admin.removeAccount(uid)).rejects.toThrow(/^ntfy_admin_failed$/);
  await expect(admin.ensureAccount(uid, password())).rejects.toThrow(
    /^ntfy_admin_failed$/,
  );
  run.mockImplementation(async () => {
    throw {
      code: 1,
      signal: "SIGKILL",
      stderr: `user ${username} does not exist\n`,
    };
  });
  await expect(admin.removeAccount(uid)).rejects.toThrow(/^ntfy_admin_failed$/);
});
