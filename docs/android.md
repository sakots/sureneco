# Android版の開発と配布準備

現在は実装中です。ARM64のデバッグAPK生成と、PHPの単発CLI・状態API・SQLite保存・排他・異常終了後の再実行をローカルで確認しました。Node専用サーバーは撤去済みです。5ch取得・認証・FCM配送と、運用先へのcron登録は未実施です。Android版のAAB生成、Firebaseからの実配信、Google Play公開も未確認です。進捗は[作業項目](../openspec/changes/android-google-play/tasks.md)に記録します。

## 完成時の構成

PHPのHTTPS APIで端末の設定を受け付け、毎分cronで起動するPHPのCLIバッチが5chの板・監視スレッドの取得、判定、FCM送信を1回処理して終了します。常駐Node.jsや、バッチ内で20秒間隔に繰り返す方式は使いません。SQLiteへ監視条件、取得済みレス番号、通知イベントと送信待ちを保存し、次回のバッチで復元します。

Androidは別アプリの利用中・画面消灯中もプッシュを受け取ります。端末内で20秒ごとに常駐取得する方式ではありません。表示中の一覧取得とOS通知を分離し、通知はプッシュへ統一します。圏外、通知拒否、Android設定での強制停止、FCMの配送遅延等では受信できない場合があります。

Androidのサーバー監視は最短約1分です。`update_sec`は既定60秒、`thread_update_sec`は既定300秒で、どちらも60秒以上の整数を受け付けます。実際には設定間隔を経過した後のcron実行回で処理するため、70秒設定なら通常約120秒間隔となり、負荷やcron・FCMの遅延でさらに遅れる場合があります。PC版の20秒更新は変更しません。

PC版のトレイ、実行ファイル指定、設定フォルダー変更、ウィンドウ状態の保存、GitHub経由の更新はAndroidに持ち込みません。Androidのアプリ更新はGoogle Playから行います。

## 必要な環境

- アプリ開発用のNode.js、pnpm、Rust。バージョンと既存のチェック手順は[開発手順](development.md)を参照。運用サーバーにはNode.jsを要求しません。
- Java 21、Android SDK Command-line Tools、Platform Tools、API 36以上、NDK、ARM64用Rustターゲット。
- 実機またはエミュレーター。ネイティブ依存を含む16KBページサイズの動作も確認。
- Google Playのアプリ登録と、Android用アップロード署名鍵。PC版の更新署名鍵は使いません。
- PHPのWeb・CLI実行環境、毎分cron、SQLiteの永続保存領域、HTTPSのAPI公開先。SQLite・HTTPS通信・署名検証に必要なPHP拡張と実行時間制限を確認。
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

## PHPサーバーとcronの構成

cronのスケジュールは`* * * * *`です。各起動で期限を迎えた取得・判定と送信可能なoutboxを処理し、次回まで待機せず終了します。再試行待ちと未処理分は永続DBへ残し、次回以降に期限と設定リビジョンを再確認します。同じ板・スレッドの取得はバッチ内で共有します。

同じDBを使うバッチの重複実行は固定ロックファイルの非ブロッキング`flock`でスキップします。ロックファイルを削除せず、正常終了・異常終了時のOSによる解放を使います。DB・ロック・資格情報はWeb公開領域の外へ置き、PHP APIとCLIが同じ永続データへアクセスできるようにします。

APIの応答成功だけでcron監視が正常とは扱いません。バッチの最終開始・終了、最終取得成功、取得・配信エラーと送信待ちの滞留を確認します。PHP基盤の初期段階では実行時刻の保存と状態照会を提供し、`monitoringReady: false`を返します。5ch取得・認証・FCM配送は別の作業項目です。

CLIは`php server/cron.php`で1回実行します。`SURENECO_SERVER_DB`でDBファイルを指定し、未指定時は`server/data/monitor.sqlite`を使います。ローカルAPIは`php -S 127.0.0.1:8787 -t server/public server/public/index.php`で起動し、`GET /healthz`で保存状態を確認します。PHP組み込みサーバーはローカル検証専用です。運用時はHTTPS対応Webサーバーの公開ルートを`server/public`に限定します。

毎分cronにはPHP実行ファイル・`server/cron.php`・DB保存先を絶対パスで登録します。重複実行は`status: skipped`で処理せず終了し、実行失敗は非ゼロ終了です。Node専用サーバー、テスト、ビルド・起動コマンドは撤去済みで、Androidのビルド基盤は維持しています。PHP 8.5 CLIとPDO SQLiteでローカル実行を確認しました。`pnpm test:server`でPHPプロセスの回帰テストを実行します。cronサービスへの登録・毎分実行は運用先で別途確認します。

## 認証・保存と停止

通知の利用開始前に、サーバーへ保存する情報と削除方法を説明して同意を受けます。Firebase匿名認証で端末を識別し、監視スレッド、板URL、更新周期、検出条件、NG・許可ワッチョイ、有効期間、FCM通知先と設定リビジョンを同期します。PC用の実行ファイルパスや設定フォルダーは送信しません。

監視停止時は端末で即時に通知を抑止し、サーバーでも購読と送信待ちを止めます。登録削除ではその端末の通知先、監視設定、配信履歴を削除します。圏外ではサーバー反映待ちと表示し、通信回復後に再送します。

秘密鍵、認証トークン、FCMトークン、NG全文を通常ログへ出しません。サーバー資格情報はAndroid配布物へ含めません。

## 検証と公開の区別

ローカルテスト、Androidクロスビルド、署名付きAAB、実際のFCM受信、Play内部テスト、正式公開はそれぞれ別に確認します。モックで成功した認証・配送を、Firebaseへの実接続が成功したものとして扱いません。

契約、課金、Firebaseの新規作成、サーバーへのデプロイ、Play/GitHubでの公開はビルド処理から行いません。公開先・権限・費用負担を確認してから進めます。

## 仕様

[Android版の提案](../openspec/changes/android-google-play/proposal.md)、[設計](../openspec/changes/android-google-play/design.md)、[作業項目](../openspec/changes/android-google-play/tasks.md)を参照してください。
