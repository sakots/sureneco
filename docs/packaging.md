# 配布物の作成

[README](../README.md) / [開発環境](development.md) / [使い方](usage.md)

以下のコマンドはリポジトリのルートで実行します。

## ビルド環境とコマンド

Windows版はWindowsまたはUbuntu・WSL2（Ubuntu）、Linux版はUbuntu・WSL2（Ubuntu）で作成できます。WindowsとLinuxのnode_modulesは共有しません。WSLではWSL側のNode.js・pnpm・Rustを使い、プロジェクトをLinux側のホームディレクトリーに置いてください。

```powershell
pnpm package:win
```

```sh
pnpm package:linux
```

### Ubuntu・WSLからWindows版を作成する

Ubuntu・WSLからWindows版も作る場合は、次の準備を一度行います。Windows x64向けにcargo-xwinでクロスコンパイルし、Setup.exeとZIPを生成します。Windows版の動作確認はWindowsで行ってください。

```sh
sudo apt install clang llvm lld nsis cmake ninja-build
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
pnpm package:win
```

WSLでのチェック・ビルドには[開発環境](development.md#環境構築)に記載したUbuntu用ライブラリーも必要です。Windows版だけを作る場合も、ビルド前にLinux側のRustテストを実行するため必要になります。同じWSL上で`pnpm package:linux`、`pnpm package:win`を実行すると、両方の配布物と更新用のlatest.jsonがrelease/に揃います。クロスコンパイルの構成は[Tauri公式の手順](https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos)に沿っています。

## 出力ファイルとパッケージ情報

release/へ以下の形式で出力します。配布名とアプリのバージョンはpackage.jsonから反映します。リリース時はsrc-tauri/Cargo.tomlのバージョンも合わせて更新してください。

- `sureneco_vx.x.x_Setup.exe`
- `sureneco_vx.x.x_win.zip`
- `sureneco_vx.x.x.AppImage`
- `sureneco_vx.x.x_amd64.deb`

Ubuntuのアプリセンターで説明が文字化けしたり、`(none)`が表示されたりしないよう、配布パッケージの短い説明と長い説明は`src-tauri/tauri.conf.json`の`bundle.shortDescription`・`bundle.longDescription`に英語（ASCII）で指定します。アプリ内の日本語表示には影響しません。

## 更新用の署名鍵

`TAURI_SIGNING_PRIVATE_KEY`は、自動更新用の配布ファイルに署名する秘密鍵の場所（または鍵の内容）を指定する環境変数です。アプリは対応する公開鍵で署名を検証してから更新します。OSやバージョンが変わっても同じ鍵を使います。

この更新用の署名とWindowsのAuthenticode署名は別です。クロスコンパイルでインストーラーの署名をスキップする警告が出ても、更新用の`.sig`は生成します。

署名鍵はこの開発端末の`.secrets/updater.key`に作成済みで、Gitには含めません。鍵を別の安全な場所にも保管してください。別のWindows・WSL環境へcloneしただけでは鍵は付いてこないので、既存の鍵を同じ場所へコピーしてください。この場所なら環境変数の設定は不要です。別の場所に置く場合は`TAURI_SIGNING_PRIVATE_KEY`に鍵のフルパスを設定します。パスワード付きの鍵を使う場合は`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`も設定します。公開鍵はsrc-tauri/tauri.conf.jsonに設定済みです。鍵の内容をGitHubやチャットへ貼り付けないでください。`pnpm dev`には署名鍵は不要です。

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "D:\keys\sureneco-updater.key"
pnpm package:win
```

WSLのBashでは次のように設定します。例ではWindows側のD:\keysに保管した既存の鍵を使います。

```sh
export TAURI_SIGNING_PRIVATE_KEY="/mnt/d/keys/sureneco-updater.key"
pnpm package:win
```

## GitHub Releases用の成果物

ローカルの配布コマンドはGitHubへ公開しません。WindowsとLinuxの成果物・`.sig`を同じrelease/へ集めて、`pnpm release:manifest`で全形式を含む`latest.json`を生成してください。GitHub Releasesには配布物、`.sig`、この`latest.json`を添付します。Tauri版ではElectron用のlatest.yml・latest-linux.yml・blockmapを使いません。更新時の署名は[Tauri updater](https://v2.tauri.app/plugin/updater/)で検証します。

## SSH先でLinux版をビルドしてWindowsへ取得する

Windows側でNode.jsとWindowsのOpenSSHクライアント（`ssh`・`scp`）を用意し、次のコマンドを実行します。スクリプト自体には追加のnpmパッケージは不要です。

```powershell
node .\scripts\package-linux-ssh.mjs build-linux /home/user/dev/sureneco "D:\sureneco\release"
```

- 第1引数：SSH接続先（`user@hostname`、または`~/.ssh/config`のHost名）。ポート・鍵・踏み台はSSH設定で指定します。
- 第2引数：Linux側にあるsurenecoリポジトリの絶対パス。空白を含むパスは引用符で囲みます。`~`は使わず、`/home/user/...`と指定してください。
- 第3引数：Windows側の保存先。省略時は、このスクリプトがあるリポジトリの`release/`です。

Linux側では、上記のビルド依存、Node.js・pnpm・Rust、更新用の署名鍵を準備してください。SSH先のログインシェルから`pnpm`・`cargo`を実行できる必要があります。鍵はLinux側に置き、スクリプトでは転送しません。パスワード付きの署名鍵を使う場合は、Linux側のログイン環境で`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`を設定してください。

Linux側で`pnpm install --frozen-lockfile`、`pnpm package:linux`を順に実行し、成功した場合だけ、そのバージョンのAppImage・DEBと各`.sig`をSFTP経由の`scp`で取得します。既存の同名ファイルは上書きします。保存先のWindows版成果物は残し、取得したバージョンについて`latest.json`をローカルで再生成します。ビルド失敗時は取得せず、転送失敗時はエラーで終了します。

ソースの同期・`git pull`・GitHubへの公開は行いません。ビルドする変更は事前にLinux側へ反映してください。OpenSSH 9以降（SFTP対応のSSHサーバー）が必要です。初回接続時のホスト鍵確認とSSH認証は通常の`ssh`と同じです。
