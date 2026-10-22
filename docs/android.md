# Android版の開発と配布準備

現在は実装中です。通知サーバーはVPS上の常駐Node.jsへ切り替える方針で、Node.js版はまだ実装していません。以下のPHPに関する結果は置換前のローカル検証です。ARM64のデバッグAPK生成、PHPの単発CLI・状態API・SQLite保存・排他、署名検証と購読操作、QuickJSによる既存パーサー・募集判定と実行上限を確認しました。cronの板・dat共有取得、購読別の更新周期、初回・再開の通知基準、取得基準とイベント・outboxの同時保存、締め・期限切れの除外も実装しました。FCM送信と永続再試行はローカルの署名・HTTPフィクスチャで確認しました。実際の5ch板一覧の取得・パースは確認済みですが、実際のFCM配送、実Firebase認証、Android画面のコマンド接続と受信処理、運用先のcron登録、署名付きAAB・Google Play公開は未完了です。進捗は[作業項目](../openspec/changes/android-google-play/tasks.md)に記録します。

## 完成時の構成

VPS上の常駐Node.jsサービスが購読APIと監視・FCM送信を担当し、systemdで起動・停止・再起動を管理します。PHP＋毎分cronから置き換える方針です。Node.js版は未実装で、現状のPHP版での検証結果とは区別します。構成と準備事項は[Node.js＋VPS](node-vps.md)を参照してください。

SQLiteへ購読設定、取得済みレス番号、通知イベントと送信待ちを保存し、再起動後に復元します。既存のTypeScript判定コアを分離ワーカーで実行し、重い正規表現でAPIや他の監視を停止させない構成にします。

Androidは別アプリの利用中・画面消灯中もプッシュを受け取ります。端末内で常駐取得する方式ではありません。表示中の一覧取得とOS通知を分離し、通知はプッシュへ統一します。圏外、通知拒否、Android設定での強制停止、FCMの配送遅延等では受信できない場合があります。

Androidのサーバー監視は`update_sec`が既定60秒、`thread_update_sec`が既定300秒で、どちらも60秒以上の整数を受け付ける設計です。常駐スケジューラーが期限を迎えた購読を処理し、毎分cronの実行回には丸めません。負荷・通信・FCMによる遅延はあり、PC版の20秒更新は変更しません。

PC版のトレイ、実行ファイル指定、設定フォルダー変更、ウィンドウ状態の保存、GitHub経由の更新はAndroidに持ち込みません。Androidのアプリ更新はGoogle Playから行います。

Firebase Consoleでの準備と設定値の対応は[Firebaseの設定手順](firebase-setup.md)を参照してください。Firebase認証・FCMを使う方針とし、ntfyなどの別アプリは要求しません。

## 必要な環境

- アプリ開発用のNode.js、pnpm、Rust。バージョンと既存のチェック手順は[開発手順](development.md)を参照。運用サーバーはNode.js 24 LTSを使います。
- Java 21、Android SDK Command-line Tools、Platform Tools、API 36以上、NDK、ARM64用Rustターゲット。
- 実機またはエミュレーター。ネイティブ依存を含む16KBページサイズの動作も確認。
- Google Playのアプリ登録と、Android用アップロード署名鍵。PC版の更新署名鍵は使いません。
- LinuxのVPS、systemd、SQLiteの永続保存領域、HTTPSのAPI公開先とリバースプロキシ。Node.jsサービス用のユーザー、再起動・バックアップ・障害監視を準備。
- Firebaseプロジェクト。Androidアプリ登録、Cloud Messaging、匿名認証、App Check（公開時はPlay Integrity）を設定。

現在用意されているのはAndroid端末です。Firebaseプロジェクトと運用先は未設定です。ローカル検証と実際のFirebase接続を必要とする確認は分けて記録します。

## Androidビルドの基盤

Android版の表示名は「スレネコアラート」、パッケージ名（applicationId）は`sureneco.sakots`です。TauriのAndroid専用設定、Gradleのnamespace/applicationId、Kotlinのパッケージと表示文字列を一致させます。PC版の表示名も「スレネコアラート」とし、PC版の内部製品名・識別子、Rust crate名と配布ファイル名の`sureneco`は維持します。Firebaseへ登録するAndroidパッケージ名も`sureneco.sakots`に合わせてください。

旧パッケージでインストールしたAPKとは別アプリになります。`install -r`で旧アプリが置き換わったり、保存データが自動移行されたりはしません。旧アプリの削除やデータ移行は自動では行いません。

モバイル用のCargo featureは`mobile`です。Android CLIへ`--features mobile -- --no-default-features`を渡し、PC版の既定featureを無効にします。QuickJSはAndroid向けの生成済みバインディングを含まないため、Androidビルド時だけ`bindgen`で生成します。ホストにlibclangが必要です。Androidプロジェクトは`src-tauri/gen/android`に置き、SDKのローカルパス、生成物、署名設定はGitへ含めません。GradleからのRustビルドにもPATH上の`pnpm`を使います。

開発環境ではJava 21、API 36、Build Tools 36.0.0、NDK 28.2.13676358と`aarch64-linux-android`を準備します。SDK規約への同意が必要です。SDKをプロジェクト内に置く場合は、Git管理外の`.android-sdk/`を使えます。

Androidの公開用接続設定は、`src-tauri/gen/android/app/mobile.properties.example`を`mobile.properties`へコピーして指定します。`mobile.properties`はGit管理外です。`sureneco.apiBaseUrl`は固定HTTPS APIのURL、Firebaseの3項目は公開用アプリ識別子です。Admin SDK、FCM送信用秘密鍵、署名鍵はこのファイルへ入れません。署名付きリリースビルドでは4項目すべてが必須で、API URLが`https://`以外の場合はGradleが失敗します。

```sh
export ANDROID_HOME="$PWD/.android-sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--sysroot=$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot"
rustup target add aarch64-linux-android
pnpm tauri android build --debug --apk --target aarch64 --ci --features mobile -- --no-default-features
```

上記はLinux x64ホストの例です。別のホストではNDKの`prebuilt`配下を環境に合わせます。bindgenにもNDKのsysrootを渡し、ホストOSのCヘッダーを使わないようにします。

ビルド成功後、Windowsへ転送するAPKを配置します。失敗時は古いAPKを転送せず、先にビルドエラーを解消してください。

```sh
mkdir -p release
cp src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk release/sureneco_v0.8.3_android_debug.apk
```

この段階のAndroidエントリーポイントは起動用の基盤です。画面のコマンド接続、Firebase認証、バックグラウンド通知は別項目で実装・検証します。デバッグAPKはGoogle Play提出用の署名付きAABとは区別します。

生成先は`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`です。生成APKから表示名「スレネコアラート」、アプリID`sureneco.sakots`、versionName `0.8.3`、versionCode `1`、minSdk 24、target/compileSdk 36、ARM64のみであることを確認しました。起動ActivityとFileProvider、APK内のDEX・ネイティブJNIも新しいパッケージ名に一致しています。QuickJSを含む`libsureneco.so`のLOADセグメントは16KB整列で、APKの署名検証と`zipalign -c -P 16 4`にも合格しました。接続端末がなく、端末上の起動・募集判定と16KBページサイズ端末の動作は未確認です。

## WindowsからAndroid実機をデバッグする

この手順は「SSH先のLinuxでビルド → WindowsへAPKをコピー → WindowsにUSB接続した実機へインストール」の構成です。ADBはWindows側だけで動かし、SSHへのUSB転送、ADBポートの公開、Linuxの開発サーバーへの接続は不要です。APKにはビルド時の画面が入るため、変更確認のたびに再ビルド・再転送・上書きインストールします。ホットリロードやRustのブレークポイント実行を行う手順ではありません。

以下のコマンドは、LinuxのSSHシェルではなく**WindowsのPowerShell**で実行します。Windowsでは基本のインストール・ログ取得にAndroid Studio、Rust、Javaは不要です。

### 1. Windowsと実機を準備する

1. [公式Platform-Tools](https://developer.android.com/tools/releases/platform-tools)のWindows用ZIPを展開し、`C:\Android\platform-tools\adb.exe`を用意します。別の場所へ展開した場合は、以下の`$adb`を変更します。フルパスで起動するためPATH設定は不要です。
2. 実機の設定でビルド番号を繰り返しタップして「開発者向けオプション」を表示し、「USBデバッグ」を有効にします。設定名・場所は機種により異なります。
3. データ通信対応のUSBケーブルでWindowsと接続し、実機のロックを解除して「USBデバッグを許可」を承認します。Windowsが認識しない場合は端末メーカーのUSBドライバーを確認します。

PowerShellでパスとアプリIDを設定します。変数はそのPowerShellウィンドウ内だけで有効です。

```powershell
$adb = "C:\Android\platform-tools\adb.exe"
$appId = "sureneco.sakots"
$apk = "$HOME\Downloads\sureneco_v0.8.3_android_debug.apk"
& $adb version
& $adb devices -l
```

`devices -l`の先頭列にある端末シリアル番号を、次の`実際のシリアル番号`と置き換えます。端末やエミュレーターが複数あっても対象を間違えないよう、以後はすべて`-s $serial`を指定します。

```powershell
$serial = "実際のシリアル番号"
& $adb -s $serial get-state
```

`device`なら接続できています。`unauthorized`は実機側の許可待ち、`offline`は通信できていない状態です。ADBの秘密鍵やUSBデバッグの許可を他人へ渡さないでください。

### 2. LinuxからAPKを取得してインストールする

[Androidビルドの基盤](#androidビルドの基盤)でデバッグAPKを生成・配置してから、Windowsで次を実行します。`user@linux-host`は普段のSSH接続先、リモートのパスはリポジトリーの配置先へ変更してください。

```powershell
$sshTarget = "user@linux-host"
scp "${sshTarget}:/home/sakots/dev/sureneco/release/sureneco_v0.8.3_android_debug.apk" $apk
```

SCPが成功したことを確認してからインストールします。

```powershell
& $adb -s $serial install -r $apk
```

`Success`を確認します。`-r`は同じ署名のアプリをデータを保持して上書きします。ローカルで用意した`copy-android-apk.bat`を使う場合、保存先はBATと同じフォルダーなので`$apk`をその場所へ合わせます。このBATはGit管理外で、リポジトリーのcloneには含まれません。

現在のAPKはARM64向け・Android 7.0（API 24）以上が対象です。端末の条件は次で確認できます。

```powershell
& $adb -s $serial shell getprop ro.product.cpu.abilist
& $adb -s $serial shell getprop ro.build.version.sdk
& $adb -s $serial shell getconf PAGE_SIZE
```

ABI一覧に`arm64-v8a`が必要です。ページサイズは通常4096または16384で、16384なら16KB端末です。端末のページサイズを確認しただけでは、アプリの16KB環境での動作確認にはなりません。

### 3. 起動・終了とインストール済みバージョンを確認する

```powershell
& $adb -s $serial shell am force-stop $appId
& $adb -s $serial shell am start -W -n "${appId}/.MainActivity"
& $adb -s $serial shell dumpsys package $appId | Select-String "versionName|versionCode"
```

`Status: ok`はActivityの起動成功を示します。実機の画面も確認し、表示内容やエラーを記録してください。Android画面のコマンド接続とFCM受信はまだ未実装なので、起動成功を募集閲覧・設定保存・プッシュ受信の確認済みとは扱いません。

`force-stop`はアプリを強制停止します。通常終了やバックグラウンド移行とは異なり、再度利用者が起動するまでプッシュを受信できない場合があります。将来のバックグラウンド通知の検証では、ホームへ戻る・別アプリへ切り替える・画面を消す操作と区別してください。

### 4. Logcatで起動時のログとクラッシュを保存する

起動直後に落ちる場合はPIDを絞らず、まず次でログの取得を始めてから、**実機のホーム画面でスレネコアラートのアイコンをタップして起動**します。症状を再現したらPowerShellで`Ctrl+C`を押して取得を終了します。端末に保持されている直前のログも含まれます。

```powershell
$log = "$HOME\Downloads\sureneco-logcat-$(Get-Date -Format yyyyMMdd-HHmmss).txt"
& $adb -s $serial logcat -b main -b system -b crash -v threadtime | Tee-Object -FilePath $log
```

クラッシュ用バッファだけを後から保存する場合は、次を使います。`-d`は保存済みログを出力して終了する指定です。

```powershell
$crashLog = "$HOME\Downloads\sureneco-crash-$(Get-Date -Format yyyyMMdd-HHmmss).txt"
& $adb -s $serial logcat -b crash -d -v threadtime | Set-Content -Encoding utf8 $crashLog
```

アプリが起動し続けている場合は、メインプロセスのPIDで絞れます。

```powershell
$appPid = (& $adb -s $serial shell pidof -s $appId | Out-String).Trim()
if ($appPid) {
    & $adb -s $serial logcat "--pid=$appPid" -v threadtime
} else {
    Write-Host "アプリのプロセスがありません。起動してから再取得してください。"
}
```

PowerShellの`$PID`は予約済みの自動変数なので、ここでは`$appPid`を使います。PIDはアプリの再起動で変わります。PIDを絞るとWebViewの別プロセスやOS側のクラッシュ情報を取りこぼすため、起動失敗では先に全体ログを取得してください。LogcatにJavaScriptのすべての例外・ログが出るとは限りません。

ログには別アプリの情報、端末識別情報、通信先などが含まれます。共有前に確認し、認証情報、FCMトークン、NG全文や個人情報を取り除いてください。調査前の`logcat -c`は既存ログを消すため、この手順では実行しません。

### 5. ChromeでWebViewの画面・JavaScriptを調べる

1. 実機でデバッグAPKを起動し、WindowsのChromeで`chrome://inspect/#devices`を開きます。
2. **Discover USB devices**を有効にします。
3. スレネコアラートのWebViewが表示されたら、その下の**inspect**を開きます。
4. **Console**でJavaScriptの例外、**Network**で通信失敗、**Elements**で画面のレイアウトを確認します。

WebViewの検査にはアプリ側でWebViewデバッグが有効である必要があります。APKが`debuggable`なだけで必ず表示されるとは限りません。出てこない場合はADB接続、実機でアプリが表示中か、デバッグAPKかを確認し、アプリ側のWebViewデバッグ設定を調べます。今回の環境ではChromeからの実機検査は未確認です。公開用APKへ無条件にWebViewデバッグを有効にする設定は追加しません。

DevToolsからの一時的な画面変更はソースへ保存されません。恒久修正はLinux側のソースへ反映し、APKを再ビルド・転送・上書きインストールします。

### 6. よくあるエラー

| 症状 | 確認すること |
| --- | --- |
| `adb`が認識されない | `$adb`のフルパスを確認。PowerShellでは`& $adb`で起動する |
| `devices`に端末が出ない | USBデバッグ、データ通信対応ケーブル、USBポート、Windowsの端末用USBドライバー |
| `unauthorized` | 実機のロックを解除し、USBデバッグのRSA確認を承認。出なければ接続し直す |
| `offline` | USB接続をやり直す。改善しなければ`& $adb kill-server`、`& $adb start-server`を実行し再確認。他のADB接続も一時切断される |
| `more than one device/emulator` | `devices -l`で対象を選び、`-s $serial`を指定する |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | ARM64 APKに対し、端末のABI一覧に`arm64-v8a`があるか確認する |
| `INSTALL_FAILED_OLDER_SDK` | 端末のAPIレベルが24以上か確認する |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 既存アプリとAPKの署名が異なる。同じ署名鍵で再ビルドする。アンインストールすると端末内の設定・データが消えるため、安易に削除しない |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | インストール済みのversionCodeより古い。新しいビルドを使い、無条件にダウングレードしない |
| 起動直後に終了する・画面が真っ白 | 起動前からLogcatを取得し、クラッシュログとWebViewのConsoleを確認する。未実装のコマンド接続とも区別する |

### 7. 不具合を報告するとき

端末の機種・Androidバージョン・ABI・ページサイズ、APKのversionName/versionCode、実行した操作、発生時刻、表示されたエラー、機密情報を除いたLogcatを添えます。「初回インストール／上書き」「前面／ホーム／画面消灯／強制停止」のどれかも記録します。

この資料ではAPKの生成・識別情報とホスト側ADBのコマンドを確認しています。Windowsからの実機インストール、起動、Logcat取得、Chrome検査、16KB端末での動作は未確認です。実施後に端末と結果を記録し、未確認の項目を成功扱いにしないでください。

公式資料：[Android Debug Bridge](https://developer.android.com/tools/adb)、[Logcat](https://developer.android.com/tools/logcat)、[WebViewのリモートデバッグ](https://developer.chrome.com/docs/devtools/remote-debugging/webviews)。

## PHPサーバーとcronの構成

この節以降のPHP実装・判定ワーカー・配送処理の説明は現行コードの記録です。VPS上のNode.jsへ置き換える計画は[新構成](node-vps.md)と[作業項目](../openspec/changes/android-google-play/tasks.md)を参照してください。PHPでの成功をNode.js版の完了根拠にはしません。

実際の導入・配置・HTTPS API・cronの登録手順は[PHPサーバーのセットアップ](php-setup.md)を参照してください。

cronのスケジュールは`* * * * *`です。現在は各起動で期限を迎えた取得・判定とoutboxへの保存を処理し、次回まで待機せず終了します。同じ板・スレッドの取得はバッチ内で共有します。送信直前の購読・リビジョン・期限確認と、最大5回の再試行を実装しています。FCM実配信は公開用資格情報とAndroid受信処理を用意してから確認します。

同じDBを使うバッチの重複実行は固定ロックファイルの非ブロッキング`flock`でスキップします。ロックファイルを削除せず、正常終了・異常終了時のOSによる解放を使います。DB・ロック・資格情報はWeb公開領域の外へ置き、PHP APIとCLIが同じ永続データへアクセスできるようにします。

APIの応答成功だけでcron監視が正常とは扱いません。バッチの最終開始・終了、購読別の最終取得成功と取得エラーを保存します。実際のFCM受信は未確認のため、状態APIと購読APIは引き続き`monitoringReady: false`を返します。配信エラーと送信待ち滞留の運用監視は別の作業項目です。

CLIは`php server/cron.php`で1回実行します。`SURENECO_SERVER_DB`でDBファイルを指定し、未指定時は`server/data/monitor.sqlite`を使います。ローカルAPIは`php -S 127.0.0.1:8787 -t server/public server/public/index.php`で起動し、`GET /healthz`で保存状態を確認します。PHP組み込みサーバーはローカル検証専用です。運用時はHTTPS対応Webサーバーの公開ルートを`server/public`に限定します。

毎分cronにはPHP実行ファイル・`server/cron.php`・DB保存先を絶対パスで登録します。重複実行は`status: skipped`で処理せず終了し、実行失敗は非ゼロ終了です。Node専用サーバー、テスト、ビルド・起動コマンドは撤去済みで、Androidのビルド基盤は維持しています。PHP 8.5 CLIとPDO SQLiteでローカル実行を確認しました。`pnpm test:server`でPHPプロセスの回帰テストを実行します。cronサービスへの登録・毎分実行は運用先で別途確認します。

### 共有取得・通知基準

1回のcron内で同じ`subject.txt`・datの取得結果と取得失敗を共有します。購読別・取得先別の最終試行・成功時刻、板の候補一覧と取得エラーをSQLiteへ保存し、設定間隔に達していない購読は取得しません。HTTPはHTTPSの5ch板データだけを許可し、リダイレクト拒否、15秒・5MiBの上限を保ちます。UTF-8指定がなければCP932でデコードするため、PHPのcURLとmbstringも必要です。バッチの処理予算は50秒で、個々のHTTPへ残り時間を渡し、判定時間を確保できない仕事は基準を更新せず次回へ残します。

板一覧とdatは既存のJavaScriptパーサーをQuickJSで実行します。初回登録・監視再開・追加した監視対象では取得済みレスを通知基準とし、過去募集を送信待ちに加えません。通常更新では取得基準と一意な通知イベント・outboxを同じトランザクションで保存し、設定リビジョンが取得中に変わった場合は結果を保存しません。設定変更・バッチ再起動でも同じレスを通知候補へ重複登録しません。FCMの実配信確認は別途必要です。

2購読の単発実行で初回の板・dat取得が各1回、初回通知候補が0件、次回のdat取得が1回、新規募集の送信待ちが各購読1件となることを確認しました。実際のcron CLIを別プロセスで2回起動して送信待ちが保持され、実際の5ch板一覧も取得・パースできました。ローカル回帰テストでは70秒設定、再開・監視対象の再追加、取得中の停止、保存失敗からの回復、重い正規表現から他購読の継続、200件超の送信待ちへの締め反映を確認しています。

## 認証・保存と停止

通知の利用開始前に、サーバーへ保存する情報と削除方法を説明して同意を受けます。Firebase匿名認証で端末を識別し、監視スレッド、板URL、更新周期、検出条件、NG・許可ワッチョイ、有効期間、FCM通知先と設定リビジョンを同期します。PC用の実行ファイルパスや設定フォルダーは送信しません。

監視停止時は端末で即時に通知を抑止し、サーバーでも購読と送信待ちを止めます。登録削除ではその端末の通知先、監視設定、配信履歴を削除します。圏外ではサーバー反映待ちと表示し、通信回復後に再送します。

秘密鍵、認証トークン、FCMトークン、NG全文を通常ログへ出しません。サーバー資格情報はAndroid配布物へ含めません。

### 購読APIの契約

`/v1/subscription`は認証された本人の購読だけを扱います。`PUT`で同意済みの設定とFCM通知先を登録・更新し、`GET`で状態を確認、`DELETE`で登録を削除します。`POST /v1/subscription/stop`は購読を停止します。UIDは検証済みIDトークンから決め、要求本文で他端末を指定することは許可しません。認証には`Authorization: Bearer`と`X-Firebase-AppCheck`を使い、FCMトークンを認証に使いません。

同じ登録内容の再送ではリビジョンを増やさず、変更時には増加させます。停止は送信待ちを破棄し、削除は本人の設定・通知先・配信履歴を削除します。設定は60秒のサーバー更新下限、既存の板URL制限、対象数・本文サイズ・登録頻度の制限を通して保存します。

Firebaseのプロジェクト・アプリ設定がない場合は認証を迂回せずサービス未設定として拒否します。公開用設定、署名・期限・発行者・対象プロジェクトとApp Checkの検証を通った要求だけを受け付けます。ローカル署名検証の成功は実際のFirebaseプロジェクトでの認証成功とは区別します。

サーバーの公開用識別子は`SURENECO_FIREBASE_PROJECT_ID`、`SURENECO_FIREBASE_PROJECT_NUMBER`、`SURENECO_FIREBASE_APP_ID`で指定します。PHPのOpenSSL・cURL・PDO SQLite（SQLite 3.35以上）が必要です。公開鍵はGoogleの固定HTTPS先からTLS検証・リダイレクト拒否・5秒と256KiBの上限で取得し、有効期限内だけキャッシュします。`SURENECO_FIREBASE_KEY_CACHE`は公開領域外のディレクトリーで、既定は`server/data/firebase-keys`です。Admin秘密鍵は署名検証には使いません。

PUTのJSONは`{settings, watched, fcmToken, consent: true}`です。`settings`はPC専用項目を除いた設定、`watched`はスレッドID文字列の配列です。本文は256KiB、監視対象は100件、接続元IPは毎分120回、UIDは毎分60回、登録・更新PUTは毎分10回までです。GET応答に生のFCMトークンを含めません。設定リビジョンは整数で、同じ内容の再送では保持し、設定・通知先の変更と停止時に増加します。

保存するのはUID、通知先、監視設定・対象、同意時刻、状態とリビジョン、取得先別の試行・成功時刻とエラー、候補スレッド一覧、処理済みレス番号です。明示削除までは保持し、停止だけでは設定は削除しません。通知イベントには重複防止IDと期限、outboxには通知対象の募集本文とリビジョンを保存し、期限後の次回処理で削除します。削除時は本人の購読・取得基準・取得状態・通知履歴・送信待ちをトランザクションで削除します。レート制限にはIP・UIDのハッシュとカウンターを使い、60秒の有効期間後に次の要求で掃除します。生の認証トークンは保存しません。バックアップからの削除は運用先でも同じ方針を適用します。

正規表現は長さ・必須条件とQuickJSでのJavaScript構文検証を通して保存します。実行ファイルが利用できない場合は`503 detection_unavailable`として拒否し、PCREへ迂回しません。購読APIは引き続き`monitoringReady: false`を返します。ローカルの署名済みトークンと公開鍵フィクスチャでHTTP経由の登録・再送・他UIDの分離・通知先更新・停止・削除を確認しましたが、実際のFirebase・Androidとの接続確認ではありません。

### JavaScript判定の隔離実行

判定にはPC版と同じQuickJSと`src/core`を使い、PHPから専用実行ファイルを子プロセスとして呼び出します。PCREへの変換は行いません。Node.jsは開発・ビルド時だけ必要で、運用時には不要です。サーバーでは外部プロセスの起動許可と、サーバーOS向けにビルドした実行ファイルが必要です。

`pnpm build:worker`で`server/worker/target/release/sureneco-worker`を生成します（Windowsホストでは`.exe`付き）。配置先を変更する場合は`SURENECO_WORKER_BIN`に絶対パスを設定します。ユーザー入力をコマンド名・引数やJavaScriptコードとして渡さず、標準入力のJSONだけで判定します。QuickJSのヒープは32MiB、入力は16MiB、出力は4MiBに制限し、PHPも1秒で子プロセスを強制終了します。Linuxでは子プロセス全体の仮想メモリを128MiB、CPU時間を1秒に制限します。Windows上のPHP経路は未確認です。

PHPの`tmpfile()`で権限制限された一時ファイルを作り、子プロセスの標準入出力へ渡します。一時保存先の書き込み権限と空き容量が必要です。判定終了・エラー時に子プロセスを回収してファイルを閉じ、入力・出力を削除します。診断出力はサイズだけを監視し、内容を読み出したりログへ出したりしません。プロセスの一時記憶にも監視設定・本文が含まれるため、運用先の一時保存領域も公開領域外で保護します。

購読登録ではJavaScriptの構文を確認し、不正な正規表現を保存しません。実行時の時間・メモリ超過は取得先別・購読別の判定エラーとし、別の呼び出しは新しいプロセスで処理します。板候補のタイトル正規表現も同じ制限内で実行します。ローカルの共有取得・永続通知基準の検証と、実際のFirebase・Androidへの配送確認は別です。

## 検証と公開の区別

ローカルテスト、Androidクロスビルド、署名付きAAB、実際のFCM受信、Play内部テスト、正式公開はそれぞれ別に確認します。モックで成功した認証・配送を、Firebaseへの実接続が成功したものとして扱いません。

契約、課金、Firebaseの新規作成、サーバーへのデプロイ、Play/GitHubでの公開はビルド処理から行いません。公開先・権限・費用負担を確認してから進めます。

## 仕様

[Android版の提案](../openspec/changes/android-google-play/proposal.md)、[設計](../openspec/changes/android-google-play/design.md)、[作業項目](../openspec/changes/android-google-play/tasks.md)を参照してください。


### FCMの配送と再試行

cronは監視の後に送信待ちを一度処理し、次回まで待機しません。初回を含め最大5回、60秒から指数的に増やして最大15分とジッター、FCMのRetry-Afterを考慮して再試行します。期限以降の再試行は行いません。送信前に回数と再試行時刻を保存するため、プロセス停止後も候補を復旧でき、FCMが受理した直後の停止では同じイベントIDが再配送される場合があります。端末の重複排除は別途必要です。

通知先・条件の変更、停止、既知の締め、期限切れでは古い送信待ちを破棄します。送信中の停止や設定変更は既に開始したHTTP送信を取り消せないため、Android側もリビジョンと停止状態を確認します。FCMのUNREGISTEREDだけで当該通知先の購読を削除し、通信エラー・認証失敗・INVALID_ARGUMENTでは他の購読や通知先を削除しません。期限内の重複防止イベントは配信完了後も残します。

送信資格情報は公開領域とGit管理の外に置いたサービスアカウントJSONを`SURENECO_FCM_CREDENTIALS`の絶対パスで指定します。`SURENECO_FIREBASE_PROJECT_ID`と一致するプロジェクトのFCM HTTP v1送信権限が必要です。秘密鍵と短命のOAuthトークンはPHPプロセス内だけで扱い、API応答や通常ログへ出しません。送信先はGoogleのOAuthとFCMの固定HTTPS先で、TLS検証・リダイレクト拒否・5秒と256KiBの上限を使います。資格情報が未設定の場合は取得・判定だけを行い、送信試行回数は消費しません。

監視に最大35秒、残りを配送へ割り当て、1回の処理予算は合計50秒です。未処理分は次回へ残します。実際のFirebase・Android受信は未確認のため、`monitoringReady: false`は維持します。

ローカル検証では送信前の永続化、送信成功記録前の停止と再起動、Retry-After、5回上限、停止・設定変更・既知の締め・期限、無効通知先と通知先変更中の競合を確認しました。実際のFirebaseとAndroidへの配送成功を示すものではありません。公式資料は[FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api)、[エラーと再試行](https://firebase.google.com/docs/cloud-messaging/error-codes)、[サービスアカウント認証](https://developers.google.com/identity/protocols/oauth2/service-account)を参照してください。
