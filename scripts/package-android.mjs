import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
try {
  const signing = resolve(
    process.env.SURENECO_ANDROID_SIGNING_FILE ??
      "src-tauri/gen/android/keystore.properties",
  );
  if (!existsSync(signing))
    throw new Error(
      "Android用keystore.propertiesをGit管理外で設定してください。",
    );
  const version = JSON.parse(
    readFileSync("src-tauri/tauri.android.conf.json", "utf8"),
  ).version;
  const destination = `release/sureneco_v${version}_android.aab`;
  if (existsSync(destination))
    throw new Error("同名AABが既にあるため、上書きしません。");
  const cli = fileURLToPath(
    new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "android",
      "build",
      "--aab",
      "--target",
      "aarch64",
      "--ci",
      "--features",
      "mobile",
      "--",
      "--no-default-features",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, SURENECO_ANDROID_SIGNING_FILE: signing },
    },
  );
  if (result.status !== 0)
    throw new Error("Android AABのビルドに失敗しました。");
  const source =
    "src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab";
  if (!existsSync(source)) throw new Error("AABの生成先を確認できません。");
  mkdirSync("release", { recursive: true });
  copyFileSync(source, destination, 1);
  console.log(destination);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
