import { spawnSync } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import { artifactName, createManifest } from "./release-manifest.mjs";

export function packagePlan(platform, host, targetRoot) {
  if (
    (platform === "win" && !["win32", "linux"].includes(host)) ||
    (platform === "linux" && host !== "linux") ||
    !["win", "linux"].includes(platform)
  )
    throw new Error(
      "Windows版はWindowsまたはUbuntu・WSL、Linux版はUbuntu・WSLで作成してください。",
    );
  const cross = platform === "win" && host === "linux";
  const target = "x86_64-pc-windows-msvc";
  return {
    arguments: [
      "build",
      "--bundles",
      platform === "win" ? "nsis" : "deb,appimage",
      ...(cross ? ["--runner", "cargo-xwin", "--target", target] : []),
    ],
    output: cross
      ? join(targetRoot, target, "release")
      : join(targetRoot, "release"),
  };
}

async function packageApp(platform) {
  const root = resolve(process.env.CARGO_TARGET_DIR ?? "src-tauri/target");
  const plan = packagePlan(platform, process.platform, root);
  const signingKey =
    process.env.TAURI_SIGNING_PRIVATE_KEY ??
    (existsSync(".secrets/updater.key")
      ? resolve(".secrets/updater.key")
      : undefined);
  if (!signingKey)
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEYに更新用の署名秘密鍵またはそのパスを設定してください。",
    );
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const executable = fileURLToPath(
    new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
  );
  const built = spawnSync(process.execPath, [executable, ...plan.arguments], {
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: root,
      XWIN_CACHE_DIR: process.env.XWIN_CACHE_DIR ?? join(root, "xwin"),
      TAURI_SIGNING_PRIVATE_KEY: signingKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
        process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    },
  });
  if (built.error) throw built.error;
  if (built.status !== 0) process.exit(built.status ?? 1);
  await mkdir("release", { recursive: true });
  for (const target of platform === "win" ? ["nsis"] : ["deb", "appimage"]) {
    const extension = { nsis: ".exe", deb: ".deb", appimage: ".AppImage" }[
      target
    ];
    const directory = join(plan.output, "bundle", target);
    const files = (await readdir(directory)).filter(
      (name) => name.endsWith(extension) && name.includes(version),
    );
    if (files.length !== 1)
      throw new Error(`配布物を特定できません: ${directory}`);
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const destination = join("release", artifactName(version, target, arch));
    await copyFile(join(directory, files[0]), destination);
    await copyFile(join(directory, `${files[0]}.sig`), `${destination}.sig`);
  }
  if (platform === "win") {
    const binary = await readFile(join(plan.output, "sureneco.exe"));
    await writeFile(
      join("release", artifactName(version, "zip")),
      zipSync({ "sureneco.exe": binary }),
    );
  }
  await createManifest("release", version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await packageApp(process.argv[2]);
