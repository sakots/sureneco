import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createManifest } from "./release-manifest.mjs";

const usage = `使用方法:
  node scripts/package-linux-ssh.mjs <SSH接続先> <Linux側の絶対パス> [保存先]

例（WindowsのPowerShell）:
  node .\\scripts\\package-linux-ssh.mjs build-linux /home/user/dev/sureneco "D:\\sureneco\\release"

ポート・鍵・踏み台はOpenSSHのconfigで指定してください。
保存先を省略すると、このリポジトリのrelease/へ取得します。`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command}が失敗しました（${result.signal ?? result.status}）。`,
    );
  return result;
}

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const [host, remoteDirectory, destination] = args;
  if (!host || !remoteDirectory || args.length > 3) throw new Error(usage);
  if (host.startsWith("-"))
    throw new Error("SSH接続先にオプションは指定できません。");
  if (!posix.isAbsolute(remoteDirectory))
    throw new Error("Linux側のリポジトリは絶対パスで指定してください。");
  const output = resolve(
    destination ?? fileURLToPath(new URL("../release", import.meta.url)),
  );
  const script = `set -eu
cd -- ${quote(remoteDirectory)}
pnpm install --frozen-lockfile </dev/null >&2
pnpm package:linux </dev/null >&2
node --input-type=module <<'SURENECO_ARTIFACTS'
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { artifactName } from './scripts/release-manifest.mjs';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
const files = ['appimage', 'deb'].flatMap(target => {
  const name = artifactName(version, target, arch);
  return [name, name + '.sig'].map(name => resolve('release', name));
});
for (const file of files) {
  if (!(await stat(file)).isFile()) throw new Error('配布物がありません: ' + file);
}
console.log(JSON.stringify({ version, files }));
SURENECO_ARTIFACTS
`;
  console.log(`${host}でLinux版をビルドします: ${remoteDirectory}`);
  // ビルドのログはstderrへ流し、stdoutには成果物情報だけを受け取る。
  const built = run("ssh", ["--", host, "bash -l -s"], {
    input: script,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  const { version, files } = JSON.parse(built.stdout);
  await mkdir(output, { recursive: true });
  for (const file of files) {
    // SFTPを明示し、空白や引用符を含むLinux側のパスをシェルに解釈させない。
    run("scp", ["-s", "--", `${host}:${file}`, output]);
  }
  await createManifest(output, version);
  console.log(`Linux版 v${version}と署名を取得しました: ${output}`);
  console.log("latest.jsonを保存先の同バージョンの成果物から再生成しました。");
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
