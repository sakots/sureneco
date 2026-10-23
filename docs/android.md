# Android版の開発と配布準備

Node.js＋VPSとUnifiedPush＋自前ntfyを採用しています。[進捗](server-progress.md)に実装・検証した範囲を記録しています。VPS配備と公開HTTPSでの自動登録経路を確認し、利用者からAndroid実機でログイン情報のコピー・ntfyへの貼り付け・「監視中」への移行・実際の通知受信まで成功した報告を受けています。

Androidの画面接続・端末操作・通知設定、UnifiedPush connector 3.3.5による登録・受信とネイティブ通知判定を追加しました。Node.js側は端末別認証とWeb Push暗号化へ置き換え、Firebase SDK・公開設定を撤去しています。デバッグAPKで基本の実機通知経路を利用者が確認済みです。消灯中・停止／削除・再起動などの追加検証、署名付き公開AAB・Google Play提出は未完了です。[作業項目](../openspec/changes/android-google-play/tasks.md)を参照してください。

## 完成時の構成

VPS上の常駐Node.jsが購読APIと監視・Web Push送信を担当し、同じVPSの自前ntfyが端末へ中継します。systemdで別々の専用サービスとして管理します。[採用構成](unifiedpush-ntfy.md)と[VPS準備](node-vps.md)を参照してください。

SQLiteへ購読設定、取得済みレス番号、通知イベントと送信待ちを保存し、再起動後に復元します。既存のTypeScript判定コアを分離ワーカーで実行し、重い正規表現でAPIや他の監視を停止させない構成にします。

Androidは別アプリの利用中・画面消灯中もプッシュを受け取ります。端末内で常駐取得する方式ではありません。表示中の一覧取得とOS通知を分離し、通知はプッシュへ統一します。圏外、通知拒否、Android設定での強制停止、中継アプリの停止・配送遅延等では受信できない場合があります。

Androidのサーバー監視は`update_sec`が既定60秒、`thread_update_sec`が既定300秒で、どちらも60秒以上の整数を受け付ける設計です。常駐スケジューラーが期限を迎えた購読を処理し、毎分cronの実行回には丸めません。負荷・通信・ntfy・端末による遅延はあり、PC版の20秒更新は変更しません。

PC版のトレイ、実行ファイル指定、設定フォルダー変更、ウィンドウ状態の保存、GitHub経由の更新はAndroidに持ち込みません。Androidのアプリ更新はGoogle Playから行います。

Androidには別途中継アプリのntfyを導入し、自前サーバーを設定してもらいます。Google Play版・F-Droid版の両方を利用できます。自前サーバーへの接続ではGoogle Play版もFirebaseを使いません。F-Droid版はFirebaseの機能自体を含まない配布版です。[ntfy公式説明](https://docs.ntfy.sh/subscribe/phone/#instant-delivery)を参照してください。スレネコチェッカーにUnifiedPush connectorを追加し、中継選択・未導入・通知先更新・解除を扱います。接続維持はntfyが担当するため、そちらの常駐通知・電池設定が必要になる場合があります。

## 必要な環境

- アプリ開発用のNode.js、pnpm、Rust。バージョンと既存のチェック手順は[開発手順](development.md)を参照。運用サーバーはNode.js 24 LTSを使います。
- Java 21、Android SDK Command-line Tools、Platform Tools、API 36以上、NDK、ARM64用Rustターゲット。
- 実機またはエミュレーター。ネイティブ依存を含む16KBページサイズの動作も確認。
- Google Playのアプリ登録と、Android用アップロード署名鍵。PC版の更新署名鍵は使いません。
- LinuxのVPS、systemd、SQLiteの永続保存領域、HTTPSのAPI公開先とリバースプロキシ。Node.jsサービス用のユーザー、再起動・バックアップ・障害監視を準備。
- 自前ntfy、APIとntfyのHTTPS公開先、VAPID鍵とntfyの端末別認証・ACL設定。Firebaseプロジェクトは不要です。

Android端末・自前ntfy・運用VPSを使う基本の実機通知経路は利用者が確認済みです。消灯中や再起動後などの条件別確認は、基本の通知受信成功とは分けて扱います。

## Androidビルドの基盤

スレッドのHTTPS取得にはreqwest 0.13のAndroid証明書検証を使います。起動時にAndroidのVM・Context・クラスローダーを登録し、GradleにはCargo.lockの`rustls-platform-verifier-android`と一致するJava側ライブラリーを含めます。リリースの縮小処理でもJNIから呼ぶ検証クラスを保持します。Android単体テストで必要クラスの存在を確認し、APK生成後に署名と接続先を検証します。実機でのスレッド検索・通信失敗後の再試行は別途確認が必要です。[公式のAndroid初期化手順](https://github.com/rustls/rustls-platform-verifier#android)を参照してください。

Android版の表示名は「スレネコチェッカー」、パッケージ名（applicationId）は`sureneco.sakots`です。TauriのAndroid専用設定、Gradleのnamespace/applicationId、Kotlinのパッケージと表示文字列を一致させます。PC版の表示名も「スレネコチェッカー」とし、PC版の内部製品名・識別子、Rust crate名と配布ファイル名の`sureneco`は維持します。

旧パッケージでインストールしたAPKとは別アプリになります。`install -r`で旧アプリが置き換わったり、保存データが自動移行されたりはしません。旧アプリの削除やデータ移行は自動では行いません。

モバイル用のCargo featureは`mobile`です。Android CLIへ`--features mobile -- --no-default-features`を渡し、PC版の既定featureを無効にします。QuickJSはAndroid向けの生成済みバインディングを含まないため、Androidビルド時だけ`bindgen`で生成します。ホストにlibclangが必要です。Androidプロジェクトは`src-tauri/gen/android`に置き、SDKのローカルパス、生成物、署名設定はGitへ含めません。GradleからのRustビルドにもPATH上の`pnpm`を使います。

開発環境ではJava 21、API 36、Build Tools 36.0.0、NDK 28.2.13676358と`aarch64-linux-android`を準備します。SDK規約への同意が必要です。SDKをプロジェクト内に置く場合は、Git管理外の`.android-sdk/`を使えます。

`src-tauri/gen/android/app/mobile.properties.example`をGit管理外の`mobile.properties`へコピーし、`sureneco.apiBaseUrl`と`sureneco.ntfyOrigin`を設定します。どちらもパス・資格情報・クエリーを含まないHTTPS originです。環境変数`SURENECO_API_BASE_URL`・`SURENECO_NTFY_ORIGIN`で上書きもできます。公開ビルドは空欄・`.invalid`ホストを拒否します。署名鍵・ntfy管理資格情報・VAPID秘密鍵は含めません。`google-services.json`は不要ですがGit除外は維持します。既存のPHP用URLがパスを含む場合は、新しいAPIのoriginへ変更してください。

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

この段階のAndroidエントリーポイントは起動用の基盤です。画面のコマンド接続、端末認証、UnifiedPush受信は実装済みで、実端末との接続は別に検証します。デバッグAPKはGoogle Play提出用の署名付きAABとは区別します。

生成先は`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`です。v0.8.3の生成APKから表示名「スレネコアラート」、アプリID`sureneco.sakots`、versionName `0.8.3`、versionCode `1`、minSdk 24、target/compileSdk 36、ARM64のみであることを確認しました。起動ActivityとFileProvider、APK内のDEX・ネイティブJNIも新しいパッケージ名に一致しています。QuickJSを含む`libsureneco.so`のLOADセグメントは16KB整列で、APKの署名検証と`zipalign -c -P 16 4`にも合格しました。接続端末がなく、端末上の起動・募集判定と16KBページサイズ端末の動作は未確認です。

2026/10/23に自動登録画面を含む接続先設定済みAPKを生成しました。既存配布物を上書きせず、`release/sureneco_v0.8.9_android_ntfy-registration_debug.apk`へ保存しています。versionNameは現在のビルド設定どおり`0.8.9`です。署名検証（v2）・16KB zip整列、`sureneco.sakots`、表示名、ARM64、minSdk 24／targetSdk 36を確認しました。DEX内に設定済みのAPI／ntfy originと自動登録経路を確認しました。SHA-256は`f8a38a949c84530c3a6c836d27da65e1f38c4c2745dfb22b37fcd687bfa8bc28`です。公開APIの`/v1/ntfy-registration`は認証なしGETで404を返しており、新APIの公開は未確認です。VPS配備前のAPKを配送確認済みとは扱いません。接続済み実機がなく、インストール・ログイン・配送は未確認です。

その後VPSへ自動登録APIと管理サービスを配備し、公開HTTPSから実ntfyへの登録・権限分離・通知先変更・停止・再開・削除を確認しました。上記404は配備前の記録で、現在は認証なしGETに401を返します。2026/10/23に利用者から、Android実機でログイン情報のコピー・ntfyへの貼り付け・「監視中」への移行・実際の通知受信まで成功した報告を受けました。

ログイン情報のコピーに対応した新しいAPKは`release/sureneco_v0.8.9_android_ntfy-login-copy_debug.apk`です。サーバーURL・ユーザー名・パスワードをそれぞれコピーし、ntfyの同じ入力欄へ貼り付けられます。パスワードは隠したままコピーでき、Androidの機密クリップボード属性を設定します。コピー履歴に残る可能性があるため、貼り付け後は必要に応じて履歴を削除してください。署名・16KB zip整列を確認しました。SHA-256は`dd43d846ecf6352ae083dd513038451af724d286a5779334496b6487601ab8b0`です。ブラウザーの390px画面で3項目のコピー内容・パスワードの非表示維持・横方向のはみ出しがないことを確認しました。ブラウザー確認は状態fixtureとWebクリップボードを使っており、Android実機での貼り付け・機密プレビュー抑止の確認とは区別します。

上記のブラウザー確認後、コピー・貼り付けと通知受信は利用者の実機でも成功しています。機密クリップボードのプレビュー抑止、消灯中の受信、停止・削除・再起動後の動作を確認したとは扱いません。

## 通知を設定する

設定画面の「バックグラウンド通知」にある「ntfyの準備・設定手順」を開くと、ntfyの役割、Google Play版・F-Droid版の導入、デフォルトサーバー、通知・電池設定、自動発行した端末用アカウントでのログイン、確認待ち時の対処を読めます。接続先はアプリの設定値を表示し、未設定の場合は配布元への確認を案内します。説明を開くだけでは通知を有効化しません。

API・ntfyの接続先が未準備の場合は、先に[接続先の準備手順](push-server-setup.md)を参照してください。

ntfyアプリを導入して自前サーバーを設定し、スレネコチェッカーで通知を許可します。保存する情報への同意を選択して「通知を有効にする」を押し、中継アプリを選びます。通知先の取得後にサーバーへ端末用アカウントとトピック読み取り権限を自動登録します。画面に表示された接続先・ユーザー名・パスワードをntfyのユーザー管理へ入力してください。パスワードは初期状態で隠し、必要なときだけ表示します。運用者へトピックを渡す必要はありません。権限設定と通知先の所有確認が完了すると「監視中」になります。サーバー側は[限定管理プロセスの配置](ntfy-registration-automation.md#ローカル管理プロセスの配置)が必要です。

「同期を再試行」で保留中の登録・設定を再送します。「監視を停止」は端末で先に通知を抑止し、圏外ならサーバー反映待ちとして保持します。要求受付後もntfyアカウントの撤去が保留中なら、撤去完了と区別して表示します。「サーバー登録を削除」はAPI受付後に端末認証・ntfy資格情報を消し、サーバーの購読・履歴を削除します。ntfy側の撤去はサーバーの永続ジョブで続行し、端末は認証破棄後の撤去完了を確認したとは表示しません。アプリのバックアップは無効にして資格情報の復元・共有を防ぎます。

画面表示中だけ一覧を更新し、ネイティブ側でもバックグラウンドの取得を拒否します。OS通知はプッシュ受信に統一し、表示中の一覧更新から二重通知しません。端末認証は30日経過後の起動時に更新し、切断時には更新候補を保持して再試行します。実端末での更新・切断の確認は残っています。

## 署名付きAABの準備

Git管理外の`src-tauri/gen/android/keystore.properties`へ`storeFile`（絶対パス）・`storePassword`・`keyAlias`・`keyPassword`を設定します。Android用アップロード鍵を使い、PC更新用鍵は使いません。`SURENECO_ANDROID_SIGNING_FILE`で設定ファイルの絶対パスも指定できます。

`pnpm package:android`はチェック後にAABを生成し、`release/sureneco_vVERSION_android.aab`へ配置します。署名設定不足・公開接続先不足・同名出力では失敗し、PlayやGitHubへ公開しません。実際のアップロード鍵による公開AABの生成・検証はまだ行っていません。

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

`Status: ok`はActivityの起動成功を示します。実機の画面も確認し、表示内容やエラーを記録してください。Android画面・UnifiedPush受信は実装済みですが、起動成功だけを募集閲覧・設定保存・プッシュ受信の確認済みとは扱いません。

`force-stop`はアプリを強制停止します。通常終了やバックグラウンド移行とは異なり、再度利用者が起動するまでプッシュを受信できない場合があります。将来のバックグラウンド通知の検証では、ホームへ戻る・別アプリへ切り替える・画面を消す操作と区別してください。

### 4. Logcatで起動時のログとクラッシュを保存する

起動直後に落ちる場合はPIDを絞らず、まず次でログの取得を始めてから、**実機のホーム画面でスレネコチェッカーのアイコンをタップして起動**します。症状を再現したらPowerShellで`Ctrl+C`を押して取得を終了します。端末に保持されている直前のログも含まれます。

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

ログには別アプリの情報、端末識別情報、通信先などが含まれます。共有前に確認し、認証情報、通知先URL・暗号化鍵、NG全文や個人情報を取り除いてください。調査前の`logcat -c`は既存ログを消すため、この手順では実行しません。

### 5. ChromeでWebViewの画面・JavaScriptを調べる

1. 実機でデバッグAPKを起動し、WindowsのChromeで`chrome://inspect/#devices`を開きます。
2. **Discover USB devices**を有効にします。
3. スレネコチェッカーのWebViewが表示されたら、その下の**inspect**を開きます。
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
| 起動直後に終了する・画面が真っ白 | 起動前からLogcatを取得し、クラッシュログとWebViewのConsoleを確認する。ネイティブ接続・API設定の失敗も確認する |

### 7. 不具合を報告するとき

端末の機種・Androidバージョン・ABI・ページサイズ、APKのversionName/versionCode、実行した操作、発生時刻、表示されたエラー、機密情報を除いたLogcatを添えます。「初回インストール／上書き」「前面／ホーム／画面消灯／強制停止」のどれかも記録します。

この資料ではAPKの生成・識別情報とホスト側ADBのコマンドを確認しています。Windowsからの実機インストール、起動、Logcat取得、Chrome検査、16KB端末での動作は未確認です。実施後に端末と結果を記録し、未確認の項目を成功扱いにしないでください。

公式資料：[Android Debug Bridge](https://developer.android.com/tools/adb)、[Logcat](https://developer.android.com/tools/logcat)、[WebViewのリモートデバッグ](https://developer.chrome.com/docs/devtools/remote-debugging/webviews)。

## Node.jsサーバーと監視の構成

[通知方式の設計](unifiedpush-ntfy.md)に端末別認証、チャレンジによる通知先所有確認、暗号化配送、停止・削除のAPI計画をまとめています。[VPS準備](node-vps.md)に常駐API・ntfy・SQLite・systemd・HTTPSと負荷確認をまとめています。

共有取得と募集判定には既存TypeScriptコアを使い、NG・許可ワッチョイ・参照による5桁ID・締め・期限を維持します。送信前とネイティブ受信時にイベントID・リビジョン・通知先世代・期限・停止を確認し、表示中もローカル更新からOS通知を重複発行しません。鍵・生トークン・通知先URL・auth secret・NG全文は通常ログに出しません。

## 検証と公開の区別

ローカルテスト、Androidビルド、署名付きAAB、実際の自前ntfy・Androidへの配送、VPS配備、Play内部テスト、正式公開は別に確認します。`monitoringReady: false`を維持し、旧Firebase試作のテストを新方式の接続成功として扱いません。

端末認証、通知先変更、停止・削除、別アプリ利用、画面消灯、ntfy停止・再接続と電池制限を検証します。ntfy受付成功だけでは端末に表示できたとは判断しません。契約・課金・デプロイ・公開はビルドから行いません。

## 仕様

[Android版の提案](../openspec/changes/android-google-play/proposal.md)、[設計](../openspec/changes/android-google-play/design.md)、[作業項目](../openspec/changes/android-google-play/tasks.md)を参照してください。
