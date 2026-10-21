# Android版の開発と配布準備

現在は実装中です。ARM64のデバッグAPK生成とローカルサーバーの起動・復旧は確認済みです。Android版のAAB生成、Firebaseからの実配信、Google Play公開はまだ確認していません。進捗は[作業項目](../openspec/changes/android-google-play/tasks.md)に記録します。

## 完成時の構成

Node.jsの常駐サーバーが5chの板・監視スレッドを取得し、既存の募集判定・NG・許可ワッチョイを端末ごとに適用します。SQLiteへ監視条件、取得済みレス番号、通知イベントと送信待ちを保存し、Firebase Cloud Messaging（FCM）でAndroidへ配信します。

Androidは別アプリの利用中・画面消灯中もプッシュを受け取ります。端末内で20秒ごとに常駐取得する方式ではありません。表示中の一覧取得とOS通知を分離し、通知はプッシュへ統一します。圏外、通知拒否、Android設定での強制停止、FCMの配送遅延等では受信できない場合があります。

PC版のトレイ、実行ファイル指定、設定フォルダー変更、ウィンドウ状態の保存、GitHub経由の更新はAndroidに持ち込みません。Androidのアプリ更新はGoogle Playから行います。

## 必要な環境

- Node.js、pnpm、Rust。バージョンと既存のチェック手順は[開発手順](development.md)を参照。
- Java 21、Android SDK Command-line Tools、Platform Tools、API 36以上、NDK、ARM64用Rustターゲット。
- 実機またはエミュレーター。ネイティブ依存を含む16KBページサイズの動作も確認。
- Google Playのアプリ登録と、Android用アップロード署名鍵。PC版の更新署名鍵は使いません。
- 常時Node.jsを動かせるサーバー、SQLiteの永続保存領域、HTTPSのAPI公開先。
- Firebaseプロジェクト。Androidアプリ登録、Cloud Messaging、匿名認証、App Check（公開時はPlay Integrity）を設定。

現在用意されているのはAndroid端末です。Firebaseプロジェクトと運用先は未設定です。ローカル検証と実際のFirebase接続を必要とする確認は分けて記録します。

## Androidビルドの基盤

モバイル用のCargo featureは`mobile`です。Android CLIへ`--features mobile -- --no-default-features`を渡し、PC版の既定featureを無効にします。QuickJSはAndroid向けの生成済みバインディングを含まないため、Androidビルド時だけ`bindgen`で生成します。ホストにlibclangが必要です。Androidプロジェクトは`src-tauri/gen/android`に置き、SDKのローカルパス、生成物、署名設定はGitへ含めません。GradleからのRustビルドにもPATH上の`pnpm`を使います。

開発環境ではJava 21、API 36、Build Tools 36.0.0、NDK 28.2.13676358と`aarch64-linux-android`を準備します。SDK規約への同意が必要です。SDKをプロジェクト内に置く場合は、Git管理外の`.android-sdk/`を使えます。

```sh
export ANDROID_HOME="$PWD/.android-sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--sysroot=$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot"
rustup target add aarch64-linux-android
pnpm tauri android build --debug --apk --target aarch64 --ci --features mobile -- --no-default-features
```

上記はLinux x64ホストの例です。別のホストではNDKの`prebuilt`配下を環境に合わせます。bindgenにもNDKのsysrootを渡し、ホストOSのCヘッダーを使わないようにします。

この段階のAndroidエントリーポイントは起動用の基盤です。画面のコマンド接続、Firebase認証、バックグラウンド通知は別項目で実装・検証します。デバッグAPKはGoogle Play提出用の署名付きAABとは区別します。

生成先は`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`です。生成物からアプリID`io.github.sakots.sureneco`、versionName `0.8.3`、versionCode `1`、minSdk 24、target/compileSdk 36、ARM64のみであることを確認しました。QuickJSを含む`libsureneco.so`のLOADセグメントは16KB整列、APKも`zipalign -c -P 16 4`に合格しています。接続端末がなく、端末上の起動・募集判定と16KBページサイズ端末の動作は未確認です。

## Nodeサーバーのローカル基盤

Firebase設定と固定HTTPS API先の準備を待つ間は、接続先設定を未完了としてNodeサーバーを先行実装します。ローカル基盤はループバックでのみ公開し、SQLiteへワーカーの状態を保存します。同じDBのワーカーを別プロセスから起動すると、SQLiteの排他ロックで拒否します。プロセス停止時にはOSがロックを解放し、ロック用ファイルは削除しません。

この基盤だけでは5chの取得・認証・通知配信は行いません。ヘルスチェックの応答はプロセスの生存確認であり、通知配送の成功を意味しません。

ローカル起動には`pnpm server:start`を使います。`SURENECO_SERVER_DB`でSQLiteファイルを指定し、未指定時はGit管理外の`server/data/monitor.sqlite`へ保存します。`PORT`は既定8787、待受先は`127.0.0.1`固定です。`GET /healthz`は保存済みの`lastTickAt`と`monitoringReady: false`を返します。20秒周期のワーカー実行時刻だけを記録し、未実装の募集監視を稼働中とは表示しません。

停止はSIGINTまたはSIGTERMで行い、HTTP待受とタイマー、DBを閉じます。DBと隣接する`.worker-lock`は一組としてローカルの永続領域へ置きます。ロックは別のSQLite接続の排他トランザクションで保持するため、ロックファイルの存在だけでは起動を拒否せず、異常終了後も再起動できます。SQLiteのロックを保証しないネットワーク共有上には置きません。

## 認証・保存と停止

通知の利用開始前に、サーバーへ保存する情報と削除方法を説明して同意を受けます。Firebase匿名認証で端末を識別し、監視スレッド、板URL、更新周期、検出条件、NG・許可ワッチョイ、有効期間、FCM通知先と設定リビジョンを同期します。PC用の実行ファイルパスや設定フォルダーは送信しません。

監視停止時は端末で即時に通知を抑止し、サーバーでも購読と送信待ちを止めます。登録削除ではその端末の通知先、監視設定、配信履歴を削除します。圏外ではサーバー反映待ちと表示し、通信回復後に再送します。

秘密鍵、認証トークン、FCMトークン、NG全文を通常ログへ出しません。サーバー資格情報はAndroid配布物へ含めません。

## 検証と公開の区別

ローカルテスト、Androidクロスビルド、署名付きAAB、実際のFCM受信、Play内部テスト、正式公開はそれぞれ別に確認します。モックで成功した認証・配送を、Firebaseへの実接続が成功したものとして扱いません。

契約、課金、Firebaseの新規作成、サーバーへのデプロイ、Play/GitHubでの公開はビルド処理から行いません。公開先・権限・費用負担を確認してから進めます。

## 仕様

[Android版の提案](../openspec/changes/android-google-play/proposal.md)、[設計](../openspec/changes/android-google-play/design.md)、[作業項目](../openspec/changes/android-google-play/tasks.md)を参照してください。
