import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { pushConfig } from "../server/web-push";

it("generates usable private VAPID keys through native Node ESM without printing or overwriting them", () => {
  const directory = mkdtempSync(join(tmpdir(), "sureneco-vapid-"));
  try {
    const destination = join(directory, "vapid.json");
    const args = [
      resolve("scripts/generate-vapid.mjs"),
      destination,
      "mailto:operator@example.com",
    ];
    const output = execFileSync(process.execPath, args, { encoding: "utf8" });
    expect(output).toBe("VAPID file created; keys were not printed.\n");
    const original = readFileSync(destination, "utf8");
    const config = pushConfig({
      SURENECO_NTFY_ORIGIN: "https://push.example.com",
      SURENECO_VAPID_FILE: destination,
    });
    expect(config?.publicKey).toHaveLength(87);
    expect(config?.privateKey).toHaveLength(43);
    if (process.platform !== "win32")
      expect(statSync(destination).mode & 0o777).toBe(0o600);
    const repeated = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(repeated.status).toBe(1);
    expect(repeated.stdout).toBe("");
    expect(repeated.stderr).toBe("VAPID file unavailable or already exists.\n");
    expect(readFileSync(destination, "utf8")).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
