import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";

function requireCheck(value, code) {
  if (!value) throw new Error(code);
}
function scalar(text, key, separator) {
  const line = text
    .split(/\r?\n/)
    .find((row) => row.startsWith(key + separator));
  requireCheck(line, "missing_config_value");
  let value = line.slice(key.length + separator.length).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    value = value.slice(1, -1);
  return value;
}
async function verify(tree) {
  requireCheck(process.getuid?.() === 0, "root_required");
  requireCheck(tree && path.isAbsolute(tree), "absolute_restore_tree_required");
  const root = fs.realpathSync(tree);
  requireCheck(root !== "/", "live_root_refused");
  const file = (absolute) => {
    requireCheck(
      absolute.startsWith("/") && !absolute.includes("\0"),
      "invalid_restore_path",
    );
    const result = fs.realpathSync(path.resolve(root, "." + absolute));
    requireCheck(
      result.startsWith(root + "/") && fs.statSync(result).isFile(),
      "restore_path_escapes_tree",
    );
    return result;
  };
  const env = fs.readFileSync(file("/etc/sureneco/server.env"), "utf8");
  const config = fs.readFileSync(file("/etc/ntfy/server.yml"), "utf8");
  const appPath = scalar(env, "SURENECO_SERVER_DB", "=");
  const authPath = scalar(config, "auth-file", ":");
  const cachePath = scalar(config, "cache-file", ":");
  const databases = [appPath, authPath, cachePath].map((name) => {
    const db = new DatabaseSync(file(name), { readOnly: true });
    try {
      const integrity = db.prepare("PRAGMA integrity_check").all();
      const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
      requireCheck(
        integrity.length === 1 &&
          Object.values(integrity[0])[0] === "ok" &&
          foreignKeys.length === 0,
        "sqlite_integrity_failed",
      );
      return { database: name, integrity: "ok", foreignKeyErrors: 0 };
    } finally {
      db.close();
    }
  });
  const vapid = JSON.parse(
    fs.readFileSync(file(scalar(env, "SURENECO_VAPID_FILE", "=")), "utf8"),
  );
  const ec = createECDH("prime256v1");
  ec.setPrivateKey(Buffer.from(vapid.privateKey, "base64url"));
  requireCheck(
    ec.getPublicKey().toString("base64url") === vapid.publicKey,
    "vapid_keypair_mismatch",
  );
  const app = new DatabaseSync(file(appPath), { readOnly: true });
  let account;
  let state;
  try {
    account = app
      .prepare(
        "SELECT username,password,topic FROM ntfy_registrations WHERE state='ready' AND desired=1 AND removed=0 LIMIT 1",
      )
      .get();
    state = {
      devices: app.prepare("SELECT COUNT(*) AS n FROM devices").get().n,
      subscriptions: app
        .prepare("SELECT COUNT(*) AS n FROM subscriptions")
        .get().n,
      confirmed: app
        .prepare(
          "SELECT COUNT(*) AS n FROM subscriptions WHERE active=1 AND confirmed=1",
        )
        .get().n,
      pendingJobs: app.prepare("SELECT COUNT(*) AS n FROM ntfy_jobs").get().n,
      queuedNotifications: app.prepare("SELECT COUNT(*) AS n FROM outbox").get()
        .n,
    };
  } finally {
    app.close();
  }
  requireCheck(account, "ready_account_required_for_acl_verification");
  requireCheck(
    /^up[A-Za-z0-9_-]{1,62}$/.test(account.topic),
    "invalid_account_topic",
  );
  const ids = ["-u", "-g"].map((option) => {
    const r = spawnSync("/usr/bin/id", [option, "ntfy"], { encoding: "utf8" });
    requireCheck(
      r.status === 0 && /^\d+\s*$/.test(r.stdout),
      "ntfy_user_required",
    );
    return Number(r.stdout.trim());
  });
  const scratch = fs.mkdtempSync("/var/tmp/sureneco-backup-verify-");
  fs.chownSync(scratch, ...ids);
  fs.chmodSync(scratch, 0o700);
  let child;
  let closed;
  let didClose = false;
  const abort = new AbortController();
  const cancel = () => {
    abort.abort();
    child?.kill("SIGTERM");
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    for (const suffix of ["", "-wal"]) {
      const source = path.resolve(root, "." + authPath) + suffix;
      if (!fs.existsSync(source)) continue;
      requireCheck(
        fs.realpathSync(source).startsWith(root + "/"),
        "restore_path_escapes_tree",
      );
      const target = path.join(scratch, "user.db" + suffix);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chownSync(target, ...ids);
      fs.chmodSync(target, 0o600);
    }
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const value = server.address().port;
        server.close((error) => (error ? reject(error) : resolve(value)));
      });
    });
    requireCheck(!abort.signal.aborted, "interrupted");
    const isolatedConfig = path.join(scratch, "ntfy.yml");
    fs.writeFileSync(
      isolatedConfig,
      `base-url: http://127.0.0.1:${port}\nlisten-http: 127.0.0.1:${port}\nauth-file: ${scratch}/user.db\nauth-default-access: deny-all\ncache-duration: 0s\nlog-level: error\n`,
      { flag: "wx", mode: 0o600 },
    );
    fs.chownSync(isolatedConfig, ...ids);
    child = spawn(
      "/usr/sbin/runuser",
      [
        "-u",
        "ntfy",
        "--",
        "/usr/bin/ntfy",
        "serve",
        "--config",
        isolatedConfig,
      ],
      {
        cwd: scratch,
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin", HOME: scratch, LANG: "C" },
      },
    );
    closed = new Promise((resolve) => {
      child.once("close", () => {
        didClose = true;
        resolve();
      });
      child.once("error", () => {
        didClose = true;
        resolve();
      });
    });
    const request = (route, headers = {}) =>
      fetch(`http://127.0.0.1:${port}${route}`, {
        headers,
        redirect: "manual",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]),
      });
    let ready = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !didClose && !abort.signal.aborted) {
      try {
        const r = await request("/v1/health");
        await r.body?.cancel();
        if (r.status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    requireCheck(ready, "isolated_ntfy_not_ready");
    const headers = {
      Authorization:
        "Basic " +
        Buffer.from(account.username + ":" + account.password).toString(
          "base64",
        ),
    };
    const own = await request("/" + account.topic + "/auth", headers);
    const other = await request(
      "/upverify" + randomBytes(12).toString("hex") + "/auth",
      headers,
    );
    await own.body?.cancel();
    await other.body?.cancel();
    requireCheck(
      own.status === 200 && other.status === 403,
      "restored_credentials_or_acl_failed",
    );
    return {
      databases,
      vapidKeypairMatches: true,
      state,
      ntfyAuth: { ownTopic: own.status, unrelatedTopic: other.status },
      productionWrites: false,
      notificationsPublished: false,
    };
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (child && !didClose) child.kill("SIGTERM");
    if (closed)
      await Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("isolated_ntfy_stop_timeout")),
            10000,
          ).unref(),
        ),
      ]);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
process.umask(0o077);
verify(process.argv[2])
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(
      /^[a-z_]+$/.test(error.message)
        ? error.message
        : "backup_verification_failed",
    );
    process.exitCode = 1;
  });
