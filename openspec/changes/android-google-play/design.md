# Design

## Context

動機と対象範囲はproposal.mdを参照する。現行はv0.8.3、Rustのdesktop featureが既定で、Tauriの起動処理・通知・クリップボード・監視スレッドがsrc-tauri/src/desktop.rsにまとまっている。src/lib.rsにモバイルのエントリーポイントとライブラリ用crate-typeがなく、src-tauri/gen/全体がGit管理外である。

判定処理はsrc/core、JSON経由の要求処理はsrc/backend/engine.ts、QuickJSホストはsrc-tauri/src/engine.rsに分離されているため再利用する。現在の環境にはJava 21があるが、sdkmanager・adb・Android用Rustターゲットは確認できていない。

## Goals / Non-Goals

**Goals:** Android用の起動と端末操作を追加し、既存の判定と画面を共有する。デスクトップで動く経路は回帰テストで維持し、署名付きAABと検証記録を作成できるようにする。

**Non-Goals:** 常駐サービス、通知配信サーバー、FCM、iOS、Google Playへの自動公開、新しい課金やログイン機能。利用者の鍵やアカウントをこちらで新規発行しない。

## Decisions

### 1. Rustのプラットフォーム境界を分ける

Android用のライブラリエントリーポイントとCargo構成を追加する。arboard・notify-rust・トレイ・single-instance・window-state・desktop updaterはAndroidへリンクしない。既存の監視スレッドの要求キューとQuickJS初期化から共通部分だけを抽出し、OS操作のコールバックをデスクトップとAndroidで与える。判定をWebView上へ複製する案は、既存の正規表現やNGの差異が生じるため採用しない。

Android保存先はTauriのアプリ専用領域を使用する。現在のstorage::ConfigStorageの任意フォルダー指定はAndroidでは無効にする。通知・クリップボード・外部URLはTauriのモバイル対応プラグインを使い、URL・ルームIDの検証は共通コアで保つ。共通化は必要箇所だけとし、デスクトップ機能の作り直しを避ける。

### 2. 表示状態をバックエンドでも管理する

Android Activityのresume/pauseをバックエンドへ接続し、非表示中は次の定期取得を開始しない。非表示へ遷移した時点で通知を抑止するため、HTTP完了前後に状態が変わる競合もテストする。WebViewのタイマー停止だけに依存しない。

復帰時は現在のレス番号を通知基準にし直す。基準取得に成功するまで通知を抑止し、保存済み設定・監視対象は維持する。表示中は既存のupdate_secとthread_update_secの独立周期を使う。Android初版の制限をUIへ常時表示する。Foreground ServiceやWake Lockで常駐を試みる案は、合意した初版の範囲に含めない。

### 3. モバイルで利用できる機能を明示する

フロントエンドへ実行プラットフォームの情報を渡し、デスクトップ専用のUIと要求を無効にする。既存Apiの呼び出しがAndroidで未登録コマンドを連発しないよう、更新・保存先・アプリ起動の初期取得も分岐する。未対応操作を直接呼び出された場合はバックエンドでも拒否する。

360px幅、システムバー、キーボード、Androidの戻る操作を確認する。ブラウザー起動やルームIDコピーは維持するが、雀魂のデスクトップ実行ファイル指定は提供しない。Play用のアプリ更新案内を出し、既存のlatest.jsonをAndroidの更新判定に使わない。

### 4. AABの生成と公開を分離する

Androidの生成プロジェクトを初期化し、Gradle・Manifest・署名参照等の再現に必要な設定を追跡する。現在のsrc-tauri/gen/除外はAndroidプロジェクトの必要ファイルだけ追跡できる形へ変え、SDKパス、鍵、ローカル設定、ビルド結果は除外する。

minSdkはTauriの対応範囲内でAPI 24を初期値とし、targetSdk/compileSdkはAPI 36以上とする。ARM64実機向けAABを必須とし、検証用エミュレーターABIは必要時に追加する。NDKは16KBページサイズ対応のツールチェーンを用い、Rust/QuickJSを含む全.soのELFと生成APKの整列を検証する。

pnpm package:androidでチェック後にAABを生成し、release/sureneco_vVERSION_android.aabへ集める。versionNameはpackage.jsonとCargo.tomlに一致させ、versionCodeはAndroid用設定で独立した正の整数として管理し、初回1・公開ごとに増加させる。アップロード用keystoreとパスワードはGit管理外のファイルまたは環境変数で渡す。署名情報が不足する場合は提出用生成を失敗させる。ローカル開発用APKと提出用署名付きAABを区別する。

Google Play登録・アップロード・正式公開はアプリ実装と別の操作とする。Play Consoleの権限を利用できることが確認されるまで、公開完了とは報告しない。

## Risks / Trade-offs

- QuickJS等のC/Rust依存のAndroidビルド・16KBページ対応 → 最初にAndroidライブラリをクロスビルドし、エミュレーターで実際の判定経路を動かす。失敗時はAndroidの成果物を完成扱いにしない。
- アプリを離れると募集を受け取れない → 画面・説明文で制限を明示し、再開時の過去募集を通知しない。常時通知は別変更で設計する。
- 初期バンドルの審査・掲載準備 → 内部テストで実際の通信・権限・保存を検証し、プライバシーポリシーと申告は実装した通信だけに基づいて用意する。
- SDK/署名鍵/Play Consoleの不足 → 環境と不足項目を明示し、ソース実装、ローカル生成、署名、内部テスト、正式公開の状態を分けて報告する。
- 既存デスクトップ機能の共通化による回帰 → pnpm checkとWindowsのクロスビルド確認を行う。Windows実機確認は完了条件にしない。

## Migration Plan

デスクトップ設定の変換やスマホへの自動移行は追加しない。Androidは専用領域で初期設定から開始する。初回はPlayの内部テストへ提出し、端末で検証してからクローズドテスト・正式公開へ進む。不具合時は公開を止め、既存のWindows/Ubuntu配布は継続する。

## Open Questions

実装・AAB生成の後に確定できる運用上の情報として、アップロード鍵の保管場所、Play Consoleのアカウント種別と利用権限、掲載用連絡先・スクリーンショット・プライバシーポリシー公開先がある。仕様・設計を変える決定事項ではないが、署名と公開前には用意する。

## 参照資料

- https://v2.tauri.app/start/prerequisites/
- https://v2.tauri.app/distribute/google-play/
- https://developer.android.com/google/play/requirements/target-sdk
- https://developer.android.com/guide/practices/page-sizes
- https://support.google.com/googleplay/android-developer/answer/14151465

2026-10-21時点の公開資料を確認。個人アカウントの種類・作成時期によって本番公開前のクローズドテスト要件が異なるため、全利用者に一律とは記載しない。
