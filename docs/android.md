# Android版の開発と配布準備

Node.js＋VPSとUnifiedPush＋自前ntfyを採用しました。実装は[進捗を保存して中断中](server-progress.md)です。以下は目標構成と既存Android基盤の記録で、UnifiedPush受信はまだ利用できません。

AndroidのARM64デバッグAPKと表示名・識別子は確認済みです。Node.jsのAPI・SQLite・監視・配信はFirebase版の試作があり、最終一括検証は未実施です。Firebase依存の置換、Android画面の接続・認証・UnifiedPush受信、自前ntfy・VPS配備、署名付きAAB・Google Play公開は未完了です。[作業項目](../openspec/changes/android-google-play/tasks.md)を参照してください。

## 完成時の構成

VPS上の常駐Node.jsが購読APIと監視・Web Push送信を担当し、同じVPSの自前ntfyが端末へ中継します。systemdで別々の専用サービスとして管理します。[採用構成](unifiedpush-ntfy.md)と[VPS準備](node-vps.md)を参照してください。

SQLiteへ購読設定、取得済みレス番号、通知イベントと送信待ちを保存し、再起動後に復元します。既存のTypeScript判定コアを分離ワーカーで実行し、重い正規表現でAPIや他の監視を停止させない構成にします。

Androidは別アプリの利用中・画面消灯中もプッシュを受け取ります。端末内で常駐取得する方式ではありません。表示中の一覧取得とOS通知を分離し、通知はプッシュへ統一します。圏外、通知拒否、Android設定での強制停止、中継アプリの停止・配送遅延等では受信できない場合があります。

Androidのサーバー監視は`update_sec`が既定60秒、`thread_update_sec`が既定300秒で、どちらも60秒以上の整数を受け付ける設計です。常駐スケジューラーが期限を迎えた購読を処理し、毎分cronの実行回には丸めません。負荷・通信・ntfy・端末による遅延はあり、PC版の20秒更新は変更しません。

PC版のトレイ、実行ファイル指定、設定フォルダー変更、ウィンドウ状態の保存、GitHub経由の更新はAndroidに持ち込みません。Androidのアプリ更新はGoogle Playから行います。

Androidには別途中継アプリのntfyを導入し、自前サーバーを設定してもらいます。Firebaseを含まない構成の案内にはF-Droid版を使います。スレネコアラートにUnifiedPush connectorを追加し、中継選択・未導入・通知先更新・解除を扱います。接続維持はntfyが担当するため、そちらの常駐通知・電池設定が必要になる場合があります。

## 必要な環境

- アプリ開発用のNode.js、pnpm、Rust。バージョンと既存のチェック手順は[開発手順](development.md)を参照。運用サーバーはNode.js 24 LTSを使います。
- Java 21、Android SDK Command-line Tools、Platform Tools、API 36以上、NDK、ARM64用Rustターゲット。
- 実機またはエミュレーター。ネイティブ依存を含む16KBページサイズの動作も確認。
- Google Playのアプリ登録と、Android用アップロード署名鍵。PC版の更新署名鍵は使いません。
- LinuxのVPS、systemd、SQLiteの永続保存領域、HTTPSのAPI公開先とリバースプロキシ。Node.jsサービス用のユーザー、再起動・バックアップ・障害監視を準備。
- 自前ntfy、APIとntfyのHTTPS公開先、VAPID鍵とntfyの端末別認証・ACL設定。Firebaseプロジェクトは不要です。

現在用意されているのはAndroid端末です。自前ntfyと運用VPSは未設定で、実配送は未確認です。

## Androidビルドの基盤

Android版の表示名は「スレネコアラート」、パッケージ名（applicationId）は`sureneco.sakots`です。TauriのAndroid専用設定、Gradleのnamespace/applicationId、Kotlinのパッケージと表示文字列を一致させます。PC版の表示名も「スレネコアラート」とし、PC版の内部製品名・識別子、Rust crate名と配布ファイル名の`sureneco`は維持します。

旧パッケージでインストールしたAPKとは別アプリになります。`install -r`で旧アプリが置き換わったり、保存データが自動移行されたりはしません。旧アプリの削除やデータ移行は自動では行いません。

モバイル用のCargo featureは`mobile`です。Android CLIへ`--features mobile -- --no-default-features`を渡し、PC版の既定featureを無効にします。QuickJSはAndroid向けの生成済みバインディングを含まないため、Androidビルド時だけ`bindgen`で生成します。ホストにlibclangが必要です。Androidプロジェクトは`src-tauri/gen/android`に置き、SDKのローカルパス、生成物、署名設定はGitへ含めません。GradleからのRustビルドにもPATH上の`pnpm`を使います。

開発環境ではJava 21、API 36、Build Tools 36.0.0、NDK 28.2.13676358と`aarch64-linux-android`を準備します。SDK規約への同意が必要です。SDKをプロジェクト内に置く場合は、Git管理外の`.android-sdk/`を使えます。

現行`mobile.properties.example`とGradleのリリース検証には旧Firebase公開設定が残ります。実装再開時にFirebase項目を撤去し、固定HTTPS APIと自前ntfy originの設定へ置き換えます。現在の例をUnifiedPush用の完成した設定として使わないでください。`mobile.properties`はGit管理外とし、署名鍵・ntfy管理資格情報・VAPID秘密鍵はAndroid配布物へ入れません。`google-services.json`は新構成では不要ですが、既存ファイルのGit除外は維持します。

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

この段階のAndroidエントリーポイントは起動用の基盤です。画面のコマンド接続、端末認証、UnifiedPush受信は別項目で実装・検証します。デバッグAPKはGoogle Play提出用の署名付きAABとは区別します。

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

`Status: ok`はActivityの起動成功を示します。実機の画面も確認し、表示内容やエラーを記録してください。Android画面のコマンド接続とUnifiedPush受信はまだ未実装なので、起動成功を募集閲覧・設定保存・プッシュ受信の確認済みとは扱いません。

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

ログには別アプリの情報、端末識別情報、通信先などが含まれます。共有前に確認し、認証情報、通知先URL・暗号化鍵、NG全文や個人情報を取り除いてください。調査前の`logcat -c`は既存ログを消すため、この手順では実行しません。

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

## Node.jsサーバーと監視の構成

[通知方式の設計](unifiedpush-ntfy.md)に端末別認証、チャレンジによる通知先所有確認、暗号化配送、停止・削除のAPI計画をまとめています。[VPS準備](node-vps.md)に常駐API・ntfy・SQLite・systemd・HTTPSと負荷確認をまとめています。

共有取得と募集判定には既存TypeScriptコアを使い、NG・許可ワッチョイ・参照による5桁ID・締め・期限を維持します。送信前とネイティブ受信時にイベントID・リビジョン・通知先世代・期限・停止を確認し、表示中もローカル更新からOS通知を重複発行しません。鍵・生トークン・通知先URL・auth secret・NG全文は通常ログに出しません。

## 検証と公開の区別

ローカルテスト、Androidビルド、署名付きAAB、実際の自前ntfy・Androidへの配送、VPS配備、Play内部テスト、正式公開は別に確認します。`monitoringReady: false`を維持し、旧Firebase試作のテストを新方式の接続成功として扱いません。

端末認証、通知先変更、停止・削除、別アプリ利用、画面消灯、ntfy停止・再接続と電池制限を検証します。ntfy受付成功だけでは端末に表示できたとは判断しません。契約・課金・デプロイ・公開はビルドから行いません。

## 仕様

[Android版の提案](../openspec/changes/android-google-play/proposal.md)、[設計](../openspec/changes/android-google-play/design.md)、[作業項目](../openspec/changes/android-google-play/tasks.md)を参照してください。
