# Proposal

## Why

現在のsurenecoはWindows・Ubuntu向けの常駐アプリであり、Android用の起動経路と配布設定がない。Android端末で既存の募集検出・NG・通知許可設定を利用できるようにし、Google Playへ提出できるAndroid版を準備する。

## What Changes

- Android初版を追加する。利用者と確認した範囲は「Google Play配布」「surenecoを表示している間だけ監視・通知」。バックグラウンド監視、外部サーバー、プッシュ配信、iOSは対象外。
- React画面・TypeScriptの募集判定・Rust上のQuickJS実行基盤を再利用し、Android用Tauriエントリーポイント、ローカル保存、通知権限、クリップボード、外部ブラウザー起動を追加する。
- 非表示・画面消灯時に監視と通知を止め、復帰時は非表示中の募集をまとめて通知せず監視を再開する。
- モバイルではトレイ、デスクトップ実行ファイル指定、設定保存先変更、ウィンドウ状態保存、GitHubからのアプリ更新を提供しない。Android版の更新はGoogle Playで行う。
- Android SDK/NDKを用いた署名付きAABの作成手順、検証項目とPlay Console提出資料を整える。公開操作やアカウント登録をビルドから自動実行しない。
- Windows・Ubuntuの監視周期・トレイ・通知・配布形式は維持する。既存仕様の整理ではなく、新しい対応OSと動作を追加する変更とする。

## Capabilities

### New Capabilities

- `mobile-integration`: Android画面、ネイティブ起動、通知権限、アプリ内保存とモバイル操作。

### Modified Capabilities

- `thread-monitoring`: Androidで表示中だけ監視し、復帰時に通知基準を再設定する。
- `security-boundary`: Android向け操作・権限を制限し、デスクトップ専用操作を拒否する。
- `distribution-updates`: Google Play向けAABの生成・署名・検証・公開手順とPlay経由の更新。

## Impact

- `src-tauri/Cargo.toml`、`build.rs`、`src/lib.rs`、`src/desktop.rs`と新規モバイル実装。共通バックエンドの分離はAndroidに必要な範囲に限定する。
- `src/backend/engine.ts`、`src/core/monitor.ts`、React API・画面とライフサイクルテスト。
- Android生成プロジェクト、Tauri設定・capabilities、Android用通知・クリップボード・openerプラグイン、ビルドスクリプトと秘密情報の除外設定。
- 正式版の準備にはAndroid SDK/NDK、実機またはエミュレーター、Google Play開発者アカウント、アップロード用署名鍵が必要。現在の環境ではAndroid SDK/NDKとAndroid用Rustターゲットが未確認・未導入。Play Consoleの接続・権限も未確認。
- Google Playのtarget API要件は2026-10-21時点でAPI 36以上。Rust/QuickJS等のネイティブライブラリは16KBページサイズ端末で検証する。
