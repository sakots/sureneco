import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("Android用ライブラリにPC専用の依存を組み込まない", () => {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--format-version",
        "1",
        "--no-default-features",
        "--features",
        "mobile",
        "--filter-platform",
        "aarch64-linux-android",
        "--offline",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  const root = metadata.packages.find((p) => p.name === "sureneco");
  expect(root.targets.some((t) => t.crate_types.includes("cdylib"))).toBe(true);
  const active = new Set(metadata.resolve.nodes.map((n) => n.id));
  const names = metadata.packages
    .filter((p) => active.has(p.id))
    .map((p) => p.name);
  for (const name of [
    "arboard",
    "notify-rust",
    "tray-icon",
    "gtk",
    "tauri-plugin-single-instance",
    "tauri-plugin-window-state",
    "tauri-plugin-updater",
  ]) {
    expect(names).not.toContain(name);
  }
}, 30_000);
