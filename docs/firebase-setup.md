# Firebaseの設定手順

通知サーバーの[VPS上の常駐Node.js版](node-vps.md)を試作していますが、実装は一旦中断しています。契約済みエックスサーバーを含めて[運用費を比較中](operation-cost.md)です。Firebaseのプロジェクト・Android登録・匿名認証・App Check・FCMはこの手順で準備できます。実際のFirebase・Androidとの接続は未確認です。

Android版はFirebase Cloud Messaging（FCM）で通知を受信します。利用者にntfyなどの追加アプリをインストールしてもらう必要はありません。監視サーバーが募集を検出し、FCMを通してsurenecoへ配送します。端末の認証にはFirebase Authenticationの匿名認証、アプリの検証にはApp Checkを使います。

## 現在できること

この資料は2026-10-22時点の設定準備手順です。Firebaseプロジェクトの作成・課金設定・鍵の発行・サーバーへの配置は管理者が行います。

| 項目 | 状態 |
| --- | --- |
| Node.jsのIDトークン・App Check検証と購読API | 試作。HTTP操作・入力拒否・SDKへの不正トークン入力をローカル検証。実Firebase認証は未確認 |
| Node.jsのFCM送信・期限内の再試行 | 試作。ペイロードと配送状態遷移をローカル検証。実FCM送信は未確認 |
| Androidの公開識別子とAPI URLのビルド設定 | `mobile.properties`からBuildConfigへ取り込み済み |
| AndroidのFirebase SDK・匿名認証・App Check・FCM受信 | 未実装 |
| 実際のFirebase認証と端末への配送 | 未確認 |

まず「1〜6」の設定を準備できます。「7」の端末接続確認はAndroid側の実装後に行います。現在のデバッグAPKへ設定を追加するだけでは、FCMトークンの取得やプッシュ受信はできません。Android SDK・APK生成・Windowsからの実機デバッグは[Android版の開発手順](android.md)を参照してください。

## 1. FirebaseプロジェクトとAndroidアプリを登録する

1. [Firebase Console](https://console.firebase.google.com/)でプロジェクトを作成します。初めは検証用プロジェクトを用意し、本番と区別してください。
2. プロジェクト設定の「全般」でプロジェクトIDとプロジェクト番号を確認します。表示名とプロジェクトIDは別の値です。
3. Androidアプリを追加し、パッケージ名を **`sureneco.sakots`** にします。現行のデバッグ版も同じパッケージ名です。Node.jsサーバーのFCM送信先もこのパッケージ名に制限しています。
4. 登録したAndroidアプリのFirebaseアプリIDと、設定ファイル`google-services.json`を取得します。FirebaseアプリIDは`1:123456789012:android:...`の形式で、Androidのパッケージ名とは異なります。

[FirebaseのAndroid設定](https://firebase.google.com/docs/android/setup)に沿って登録します。この構成ではFirestore・Realtime Database・Cloud Functionsを使わないため、それらの作成は不要です。Google Analyticsも募集通知の必須機能にはしていません。

`google-services.json`を使う場合、識別子の対応は次のとおりです。複数のAndroidアプリがある場合は、`client_info.android_client_info.package_name`が上記パッケージ名のclientを選びます。

| 設定値 | JSONの項目 | 例 |
| --- | --- | --- |
| プロジェクトID | `project_info.project_id` | `sureneco-example` |
| プロジェクト番号 | `project_info.project_number` | `123456789012` |
| FirebaseアプリID | 対象clientの`client_info.mobilesdk_app_id` | `1:123456789012:android:0123456789abcdef` |

`google-services.json`はAndroidのアプリモジュールである **`src-tauri/gen/android/app/google-services.json`** に置いてください。`.gitignore`で、リポジトリー内の`google-services.json`をGit管理から除外しています。

このJSONはアプリ用の公開接続情報で、サーバーのサービスアカウント秘密鍵とは別物です。Android側の現行コードにはGoogle services GradleプラグインもFirebase SDKもまだないため、配置だけでは読み込まれません。SDK実装時にアプリモジュールへ組み込むか、FirebaseOptionsで初期化する必要があります。現時点の公開設定は手順5の`mobile.properties`に入力してください。

## 2. 匿名認証を有効にする

Firebase ConsoleのAuthenticationを開き、ログイン方法で「匿名」を有効にします。メール・パスワードやGoogleログインはこの構成では必要ありません。[匿名認証の公式手順](https://firebase.google.com/docs/auth/android/anonymous-auth)を参照してください。

Android側の実装後は、匿名ユーザーのUIDを購読の所有者として使い、SDKが取得したFirebase IDトークンをNode.js APIへ送ります。FCM登録トークンは配送先を表すもので、認証には使えません。Identity Platformの匿名アカウント自動削除を有効にする場合は、長期利用中のUID・購読の扱いも先に確認してください。

## 3. App Checkを設定する

### Google Playから配布する版

1. Firebase ConsoleのApp Checkで、登録したAndroidアプリにPlay Integrityプロバイダーを設定します。
2. アプリ署名証明書のSHA-256を登録します。Google Play App Signingを使う場合は、Play Consoleに表示される**アプリ署名鍵**の証明書を使います。アップロード鍵やローカルのデバッグ鍵と取り違えないでください。
3. Play ConsoleのPlay Integrity API設定で、同じFirebase/Google Cloudプロジェクトをリンクします。登録先のプロジェクトを一致させます。
4. Androidの実装後、リリース用にはPlay Integrityプロバイダーを初期化し、正しいApp Checkトークンを取得できることを内部テストで確認します。

要件と設定の詳細は[Play Integrityプロバイダー](https://firebase.google.com/docs/app-check/android/play-integrity-provider)を参照してください。

### 手元のデバッグAPK

ローカルで作成してADBでインストールするAPKは、検証用プロジェクトとApp CheckのDebugプロバイダーを使って確認します。

1. Android実装時に、Debugプロバイダーをデバッグビルドだけへ組み込みます。
2. デバッグアプリが出力したApp Checkのdebug secretを、Firebase ConsoleのApp Check → 対象アプリ → 「デバッグトークンの管理」で登録します。
3. SDKから発行されたApp CheckトークンをNode.js APIへ送ります。**登録用のdebug secretそのものをAPIヘッダーへ送るのではありません。**

現行APKはこのプロバイダーも未実装なので、今はConsole側の準備までです。デバッグ用secretは公開・共有せず、配布版にも含めません。[Debugプロバイダーの公式手順](https://firebase.google.com/docs/app-check/android/debug-provider)を参照してください。

Node.jsの独自APIは、Firebase Consoleの各製品向け「適用」スイッチとは別に、`server/firebase-worker.ts`のFirebase Admin SDKで常にIDトークンとApp Checkトークンを検証します。Consoleで適用をオフにしてもNode.js側の認証は省略されません。[独自バックエンドへのトークン送信](https://firebase.google.com/docs/app-check/android/custom-resource)と[検証](https://firebase.google.com/docs/app-check/custom-resource-backend)が対応する仕組みです。

## 4. FCM送信用のサービスアカウントを用意する

1. Firebase Consoleのプロジェクト設定 → Cloud Messagingで、Firebase Cloud Messaging API（HTTP v1）が有効になっていることを確認します。
2. 同じGoogle CloudプロジェクトのIAMで、サーバー送信用のサービスアカウントを作成します。例は`sureneco-fcm-sender`です。
3. このアカウントへ、対象プロジェクトの **Firebase Cloud Messaging API Admin** ロールを付与します。通知送信のためにプロジェクトのOwnerやEditorを付ける必要はありません。
4. このアカウントのJSON秘密鍵を発行し、監視・送信を担当するサーバーへ安全な経路で配置します。組織のポリシーで鍵の発行が禁止されている場合は、権限管理者に確認してください。Node.jsの試作はサービスアカウントJSON方式です。

現行の`server/firebase.ts`は、JSONの`project_id`と`SURENECO_FIREBASE_PROJECT_ID`が一致することを確認します。別プロジェクトのサービスアカウントを共用する構成には対応していません。旧式のFCMサーバーキーや、Web Push用のVAPIDキーは使いません。[HTTP v1とサービスアカウントの公式手順](https://firebase.google.com/docs/cloud-messaging/send/v1-api)を参照してください。

JSON秘密鍵はサーバーのWeb公開領域とリポジトリーの外に置きます。たとえば`/var/lib/sureneco/secrets/fcm-service-account.json`です。実行ユーザーが読めるようにし、ディレクトリーは700、ファイルは600を目安に権限を設定します。Android配布物、`mobile.properties`、GitHub、ログには含めません。これは手順1の`google-services.json`と異なり、秘密鍵を含むファイルです。

## 5. Androidの公開設定を入力する

Linux側のリポジトリーのルートから、既存の設定例をコピーします。`-n`は既存ファイルを上書きしません。

```sh
cp -n src-tauri/gen/android/app/mobile.properties.example src-tauri/gen/android/app/mobile.properties
```

コピー先がすでにある場合は上書きせず、そのファイルを編集してください。例の値はすべて自分のプロジェクトへ置き換えます。

```properties
sureneco.apiBaseUrl=https://api.example.invalid
sureneco.firebaseProjectId=sureneco-example
sureneco.firebaseProjectNumber=123456789012
sureneco.firebaseAppId=1:123456789012:android:0123456789abcdef
```

`apiBaseUrl`はGoogleのURLではなく、**自分で運用するNode.js APIのHTTPS接続先**です。`/healthz`、`/v1/subscription`等を提供するAPIの基底URLを使います。上の`example.invalid`は動作する接続先ではありません。

`mobile.properties`はGit除外されています。4項目はGradleがBuildConfigへ取り込み、リリースビルド時は空欄を拒否します。ただし、Firebase SDKを初期化するためのAPIキー等を含む設定は別途必要です。この4項目だけでSDK接続が完成したことにはなりません。

## 6. Node.jsサーバーへ設定を渡す

[VPSのセットアップ](node-vps.md)に従い、`server/server.env.example`を非公開の`/etc/sureneco/server.env`等へ配置し、プロジェクトID・番号・FirebaseアプリIDを入力します。サービスアカウントJSONは同じFirebaseプロジェクトのものを使い、`SURENECO_FCM_CREDENTIALS`に絶対パスを設定します。環境変数の対応は[VPS資料の一覧](node-vps.md#2-環境変数と資格情報を設定する)を参照してください。

環境ファイルはsystemdの`EnvironmentFile`かNode.jsの`--env-file`で読み込みます。SSHの`export`だけではsystemdへ引き継がれません。Node.js版ではPHP-FPM設定、cronラッパー、`SURENECO_WORKER_BIN`、`SURENECO_FIREBASE_KEY_CACHE`は使いません。

### 送信せずに資格情報の読込みを確認する

コードと依存・ビルド済み`dist/server`を配置したルートで、サービスユーザーにより実行します。

```sh
sudo -u sureneco /usr/bin/node --env-file=/etc/sureneco/server.env dist/server/main.mjs --check-config
```

`Firebase settings loaded; not sent.`は公開設定と資格情報の形式・プロジェクト一致を読み込めた状態です。通信・DB作成・FCM送信は行わず、送信権限や実配送を検証したことにはなりません。`Firebase not configured.`は公開設定がすべて未指定の状態です。失敗時はパス・権限・JSON・プロジェクトの一致を確認してください。

資格情報を設定せず監視だけを動かす場合は`SURENECO_FCM_CREDENTIALS`を省略します。IDトークンとApp Checkの検証には3つの公開設定が必要です。未設定時も認証を省略しません。

`GET /healthz`では監視回の最終開始・終了と送信待ちの集計を確認できます。実Firebase・Androidとの確認が終わるまでは`monitoringReady: false`を維持します。状態APIの成功と、認証・実配送の成功は別に確認してください。

## 7. Android実装後の接続確認

以下は受信機能の実装後に行う検証です。今のAPKでは完了できません。

1. アプリからFirebase SDKを初期化し、匿名認証でUID・IDトークンを取得します。デバッグ版では登録したDebugプロバイダー、本番候補はPlay IntegrityでApp Checkトークンを取得します。
2. FCM登録トークンを取得し、利用者の同意と通知許可を得てNode.js APIへ登録します。APIは`Authorization: Bearer <Firebase IDトークン>`と`X-Firebase-AppCheck: <App Checkトークン>`の両方が必要です。
3. 自分の購読だけを照会・変更・停止・削除でき、不正なトークンや他プロジェクト・他アプリの値を拒否することを確認します。トークンをチャットや公開ログへ貼らないでください。
4. 検証端末の購読に対して有効なテスト用募集イベントを生成し、Node.jsからFCM HTTP v1へ送信します。受信処理はdataペイロードのイベントID・リビジョン・期限・停止状態を確認してOS通知を表示します。
5. 前面・別アプリ利用中・画面消灯中の受信、通知タップ、重複通知の抑止、期限切れ、停止後の受信抑止を確認します。通知権限の拒否・トークン更新・通信障害も含めます。
6. Google Playの内部テストでアプリ署名とPlay Integrityを確認してから、公開準備の完了を判断します。

Firebase Consoleの「テストメッセージ」はSDKの疎通確認には使えますが、通常のnotificationメッセージの受信だけでは、surenecoのdataメッセージ判定・旧リビジョンの抑止・停止処理の検証にはなりません。

## 問題が起きた場合

| 症状 | 確認する内容 |
| --- | --- |
| デバッグAPKからFirebase接続ログが出ない | 現行APKにはFirebase SDK接続・受信処理がまだない。設定ファイルの不足と未実装を分ける |
| 匿名認証に失敗する | Authenticationの匿名プロバイダー、アプリ用接続設定とAPIキー、ネットワークを確認 |
| Node.js APIが`401 unauthorized` | プロジェクトID・番号・FirebaseアプリIDの一致、トークンの種類・期限、App Checkプロバイダーを確認 |
| Node.js APIが`503 authentication_unavailable` | APIの環境変数、Google公開鍵へのHTTPS接続、SDKワーカーの状態を確認 |
| 資格情報の読込みが失敗する | JSONの絶対パス・権限、サービスアカウント形式、同じ`project_id`かを確認 |
| 監視は動くがFCM送信が試行されない | Node.jsサービスに`SURENECO_FCM_CREDENTIALS`が渡っているか確認。未設定なら送信せず監視だけ行う |
| FCM送信が認証・権限エラーになる | Cloud Messaging APIの有効化、サービスアカウントの送信権限、鍵の失効、サーバーの時刻を確認 |
| Androidで通知を表示しない | 受信処理の実装状況、Androidの通知許可、同意と登録・同期状態、期限・リビジョン・停止状態を確認 |

設定を確認する際も、秘密鍵・ID/App Checkトークン・FCM登録トークンを出力するログは追加しません。設定値の一覧は公開識別子・APIの接続先・資格情報のファイルパスまでを管理し、鍵の中身は別に保管してください。
