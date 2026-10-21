# Proposal

## Why

現在のsurenecoはWindows・Ubuntu向けの常駐アプリであり、Android用の起動経路と配布設定がない。Google Playで配布するAndroid版を追加し、別のアプリで雀魂をプレイしている間や画面消灯中にも、条件に一致する募集をプッシュ通知で受け取れるようにする。

## What Changes

- Android版をGoogle Play向けに追加する。確認済みの方針はサーバー監視＋Firebase Cloud Messaging（FCM）による通知。「表示中のみ監視」の前案は撤回する。
- サーバーが板・スレッドを監視し、既存の募集判定・締め・期限・NG・許可ワッチョイを端末ごとの設定で適用する。端末は非表示中に5chへ定期アクセスせず、表示中・非表示中ともOS通知をプッシュへ統一する。
- 端末認証、監視設定とFCMトークンの登録・更新・削除、永続的な取得済みレス番号、重複防止と期限付き配信を追加する。利用者の監視停止後と設定変更後に古い通知を表示しない。
- サーバーへ保存する情報と用途を説明して利用開始の同意を受ける。端末側には通知許可、監視状態、設定同期状態、取得できた直近のサーバー状態を表示する。
- React画面、TypeScriptの検出コア、Rust上のQuickJS実行基盤を活用し、Android用Tauriエントリーポイント、ローカル保存、クリップボード、外部ブラウザー起動を追加する。
- モバイルではトレイ、デスクトップ実行ファイル指定、設定保存先変更、ウィンドウ状態保存、GitHubからのアプリ更新を提供しない。更新はGoogle Playから行う。
- 署名付きAAB、端末・サーバーの検証、公開資料とサーバー運用手順を準備する。アプリ実装とは別に、利用者が用意するサーバーとFirebaseプロジェクトへの接続が必要。
- iOS、端末内の常時ポーリング、Foreground Serviceによる常駐、PC版のプッシュ移行、自動契約・デプロイ・公開は対象外。Windows・Ubuntuの現行動作は維持する。

## Capabilities

### New Capabilities

- `mobile-integration`: Android画面、端末操作、通知権限、プッシュの受信と監視状態の表示。
- `push-monitoring`: 端末別の監視設定登録、サーバー側の継続監視、通知配信、停止・登録解除とデータ管理。

### Modified Capabilities

- `thread-monitoring`: Androidの表示状態に依存しないサーバー監視と、端末側の表示更新との分担。
- `security-boundary`: 認証された端末の設定同期と最小権限、デスクトップ専用操作の拒否。
- `distribution-updates`: Firebase接続設定を含むAABの生成・署名・検証・Google Play公開手順。

## Impact

- `src-tauri/Cargo.toml`、`build.rs`、`src/lib.rs`、`src/desktop.rs`と新規モバイル実装、Android生成プロジェクトとネイティブのFCM受信処理。
- `src/core`の検出・検証・監視ロジック、`src/backend/engine.ts`、React API・画面。端末側の募集通知とプッシュ受信を重複させない。
- 新規サーバー実装、HTTPS API、永続DB、監視ワーカー、FCM送信、認証・配信・障害復旧テスト。
- SDK/NDK、Android用Rustターゲット、Google Playアカウント、アップロード用署名鍵に加え、運用サーバー、HTTPS公開先、Firebaseプロジェクトとサーバー送信資格情報が必要。現環境で利用できることは未確認。
- 運用費・監視・バックアップと個人情報管理が追加される。サーバーへは監視条件・端末識別・通知先を保存するため、説明とプライバシーポリシー・データセーフティ申告を用意する。
- 2026-10-21時点のGoogle Play提出要件はAPI 36以上。ネイティブ依存を含む16KBページサイズ端末の検証も行う。ビルド成功・配信成功・審査通過・正式公開は区別する。
