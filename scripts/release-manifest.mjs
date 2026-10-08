import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function artifactName(version, target, arch = "amd64") {
  const suffix = {
    deb: `_${arch}.deb`,
    appimage: ".AppImage",
    nsis: "_Setup.exe",
    zip: "_win.zip",
  }[target];
  if (!suffix) throw new Error(`不明な配布形式: ${target}`);
  return `sureneco_v${version}${suffix}`;
}

export async function createManifest(directory, version) {
  const entries = await readdir(directory);
  const platforms = {};
  for (const name of entries) {
    if (!name.startsWith(`sureneco_v${version}`) || !name.endsWith(".sig"))
      continue;
    const artifact = name.slice(0, -4);
    let target;
    if (artifact.endsWith(".AppImage")) target = "linux-x86_64-appimage";
    else if (artifact.endsWith("_amd64.deb")) target = "linux-x86_64-deb";
    else if (artifact.endsWith("_arm64.deb")) target = "linux-aarch64-deb";
    else if (artifact.endsWith("_Setup.exe")) target = "windows-x86_64-nsis";
    else continue;
    await readFile(join(directory, artifact));
    const signature = (await readFile(join(directory, name), "utf8")).trim();
    if (!signature) throw new Error(`署名が空です: ${name}`);
    platforms[target] = {
      signature,
      url: `https://github.com/sakots/sureneco/releases/download/v${version}/${encodeURIComponent(artifact)}`,
    };
  }
  // ZIP版の更新確認にもNSIS版のリリース情報を使う。
  if (platforms["windows-x86_64-nsis"])
    platforms["windows-x86_64"] = platforms["windows-x86_64-nsis"];
  if (!Object.keys(platforms).length)
    throw new Error("署名付き配布物がありません。");
  const manifest = { version, platforms };
  await writeFile(
    join(directory, "latest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const metadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  await createManifest(process.argv[2] ?? "release", metadata.version);
}
