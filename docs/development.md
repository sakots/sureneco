# 開発

[README](../README.md) / [配布物の作成](packaging.md) / [仕様と変更管理](specification.md)

## 構成

Tauri 2 + Rust + TypeScript + Reactで実装しています。募集検出と監視はRustの専用スレッド上のQuickJSで動かし、ウィンドウを隠しても監視を続けます。Node.js・Electron・Chromiumは配布物に同梱しません。

## 環境構築

Node.js 22.12以上、pnpm 12.14.0、Rust stableを用意してください。WindowsはMSVC版Rust、Visual Studio C++ Build Tools、WebView2が必要です。Ubuntuは以下をインストールします。

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
pnpm install
pnpm dev
```

`pnpm dev`でViteとTauriを起動します。バックエンドのTypeScriptを変更した場合は開発コマンドを再起動してください。`pnpm check`でTypeScript・Rustのテスト、フロントエンドと監視エンジンのビルド、Rust整形、テーマ診断、差分チェックを行います。初回はRust依存の取得・コンパイルに時間がかかります。

`pnpm test`と`pnpm check`にはAndroidサーバーのPHPプロセステストも含まれます。PATH上のPHP CLIとPDO SQLite拡張が必要です（Ubuntuでは`sudo apt install php-cli php-sqlite3`）。WindowsでもPHP CLIと`pdo_sqlite`を有効にしてください。PHPサーバーだけの確認は`pnpm test:server`、起動・cronの手順は[Android開発](android.md)を参照してください。PC版アプリの配布物にPHPを同梱するものではありません。

詳しい環境構築は[Tauriの前提条件](https://v2.tauri.app/start/prerequisites/)を参照してください。

## 仕様と変更管理（OpenSpec）

現行仕様は [`openspec/specs/`](../openspec/specs/) に機能別で管理しています。[仕様の目次](specification.md)から各仕様と検証手順を参照できます。`openspec/config.yaml` に日本語での記述と資料ファーストの開発ルールを設定しています。

OpenSpec CLIの確認コマンド、提案・実装・アーカイブの手順は[仕様の目次の変更手順](specification.md#openspecでの変更手順)を参照してください。アプリの動作確認には別途 `pnpm check` と変更した経路の実行が必要です。
