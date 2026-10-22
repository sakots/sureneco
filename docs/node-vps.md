# Node.js＋VPSのセットアップ

Node.js版は試作段階で、利用者の指示により実装を一旦中断しています。追加費用を抑えるため、契約済みエックスサーバーを使う案も[運用費の比較](operation-cost.md)で検討中です。この資料はVPS案の作業記録であり、VPS契約を決定したものではありません。[中断時の進捗](server-progress.md)を確認してから再開してください。

[README](../README.md) / [Firebaseの設定](firebase-setup.md) / [Android開発](android.md)

Android向け通知サーバーはNode.jsのAPIと常駐スケジューラーで動作します。PHP・cron・サーバー用Rust実行ファイルは不要です。PC版のみの利用では、このサーバーを用意する必要はありません。

Node.js 24.22.1でローカルのAPI・保存・共有取得・判定・再試行・起動終了を確認しています。運用先への配備と実際のFirebase・Androidへの配送は未確認です。Androidの認証・プッシュ受信処理も実装途中のため、現在のAPKを接続するだけでは通知を受け取れません。

## 構成と必要なもの

```text
Android → HTTPS → Nginx → Node.js（127.0.0.1:8787）
                           ├─ Firebase ID・App Checkトークン検証
                           ├─ SQLite（購読・取得基準・イベント・送信待ち）
                           └─ 常駐スケジューラー
                                ├─ 5chの共有取得
                                ├─ 分離ワーカーでTypeScriptの募集判定
                                └─ Firebase Admin SDK → FCM → Android
systemd：Node.jsの起動・停止・異常終了後の再起動
```

LinuxのVPS、SSH・管理権限、systemd、Node.js 24 LTS、pnpm、永続ディスク、API用ドメイン・DNS・HTTPS証明書を用意します。Google・5chへの外向きHTTPSと正しいサーバー時刻も必要です。開発用のバージョンは[開発資料](development.md)を参照してください。Node.js 24系は検証したパッチ版を使います。[Node.jsのリリース情報](https://nodejs.org/en/about/previous-releases)も確認してください。

Firebaseの匿名認証・App Check・FCMは継続利用します。Android登録は`sureneco.sakots`です。[Firebaseの準備](firebase-setup.md)を先に行い、サーバー用サービスアカウントJSONを取得してください。`google-services.json`はAndroidアプリ用であり、サーバーの秘密鍵には使いません。

## 1. ビルドしてコードを配置する

リポジトリーのルートで実行します。

```sh
pnpm install --frozen-lockfile
pnpm test:server
pnpm build:server
```

`dist/server/`へAPIとワーカーの`.mjs`が生成されます。運用先にもNode.jsと本番用依存（Firebase Admin SDK等）が必要です。成果物だけを転送する場合も、同じリビジョンの`package.json`・`pnpm-lock.yaml`・`pnpm-workspace.yaml`を使って依存を導入してください。専用DBモジュールのネイティブビルドはありません。

以下はコード・依存・生成済み`dist/server`を`/opt/sureneco`へ配置する例です。運用先でのビルドには開発用依存が必要です。コードは配置担当ユーザー所有、サービスからは読取り専用にし、SQLiteと秘密鍵は別に保存します。

```sh
sudo useradd --system --user-group --home-dir /var/lib/sureneco --shell /usr/sbin/nologin sureneco
sudo install -d -o sureneco -g sureneco -m 700 /var/lib/sureneco
sudo install -d -o root -g sureneco -m 750 /etc/sureneco
sudo install -o root -g sureneco -m 640 server/server.env.example /etc/sureneco/server.env
```

既に専用ユーザーや環境ファイルがある場合は上書きせず、既存の内容を確認して必要な設定だけ更新してください。旧PHP版のDBの変換は行いません。旧版を利用していた場合は停止してバックアップし、新しい保存先で登録し直します。

## 2. 環境変数と資格情報を設定する

`/etc/sureneco/server.env`のサンプル値を自分の環境へ置き換えます。ファイルはsystemdの`EnvironmentFile`またはNode.jsの`--env-file`で読み込みます。PHP用の環境変数設定やcronラッパーは使いません。

| 環境変数 | 内容 |
| --- | --- |
| `SURENECO_SERVER_PORT` | ループバック待受ポート。既定8787 |
| `SURENECO_SERVER_DB` | SQLiteの保存先。運用では`/var/lib/sureneco/monitor.sqlite`等の絶対パス。未指定時は作業ディレクトリーの`server/data/monitor.sqlite` |
| `SURENECO_FIREBASE_PROJECT_ID` | Androidと同じFirebaseプロジェクトID |
| `SURENECO_FIREBASE_PROJECT_NUMBER` | Firebaseプロジェクト番号 |
| `SURENECO_FIREBASE_APP_ID` | 許可するAndroidアプリのFirebaseアプリID |
| `SURENECO_FCM_CREDENTIALS` | FCM送信用サービスアカウントJSONの絶対パス。未指定なら監視・判定のみ行い、送信しない |

サービスアカウントJSONは`/etc/sureneco/fcm-service-account.json`等へ配置し、`root:sureneco`所有・640など、サービスユーザーが読める権限にします。コード・環境ファイル・秘密鍵をWeb公開ルートへ置かないでください。秘密鍵の`project_id`は設定値と一致させます。

Firebase公開設定をすべて省略すると購読APIは503で拒否します。一部だけの設定、プロジェクト不一致、読めない・不正な資格情報は起動エラーです。認証を省略する設定はありません。

配置先のルートで、通信・DB作成・送信を行わず設定の形式と資格情報の読取りを確認できます。

```sh
sudo -u sureneco /usr/bin/node --env-file=/etc/sureneco/server.env dist/server/main.mjs --check-config
```

`Firebase settings loaded; not sent.`は設定を読み込めたことを示します。実際の送信権限・認証・配送を確認した結果ではありません。

## 3. 起動してローカルAPIを確認する

開発中はリポジトリーのルートで起動します。環境変数なしでも状態APIは利用できます。

```sh
pnpm build:server
pnpm server:start
```

運用先で環境ファイルを指定する場合は、`/opt/sureneco`から次を実行します。

```sh
sudo -u sureneco /usr/bin/node --env-file=/etc/sureneco/server.env dist/server/main.mjs
```

別ターミナルから確認し、終了はCtrl+Cで行います。

```sh
curl --fail --silent --show-error http://127.0.0.1:8787/healthz
```

`lastStartedAt`・`lastFinishedAt`はUnix時刻のミリ秒で、監視回ごとに進みます。`error`はバッチの保存等のエラー、`outbox.count`と`oldestCreatedAt`は送信待ち件数と最古の保存時刻です。購読APIは本人の取得・配送状態も返します。取得障害は購読別のエラーとして記録されるため、バッチ完了だけで全購読が正常とは判断しません。

実際のFirebase・Androidへの配送確認が終わるまで`monitoringReady: false`を返します。購読なしのバッチ完了とAPIのHTTP成功は、実配送の成功ではありません。

## 4. systemdへ登録する

手動起動を終了し、[サービス設定例](../server/sureneco.service)を配置します。実際のNode.jsのパスとコード配置先を確認してください。サンプルは`/usr/bin/node`と`/opt/sureneco`を使います。

```sh
sudo install -m 644 server/sureneco.service /etc/systemd/system/sureneco.service
sudo systemctl daemon-reload
sudo systemctl enable --now sureneco.service
sudo systemctl status sureneco.service
sudo journalctl -u sureneco.service -n 50 --no-pager
```

設定は専用ユーザー、`UMask=0077`、書込み先の制限、512MiBのメモリ上限を含みます。上限はVPS全体のメモリと負荷に合わせて調整します。異常終了は5秒後に再起動し、通常停止は処理の終了を待ちます。SIGTERMの終了猶予は60秒です。更新時はサービスを停止し、コードと生成済みワーカーを同じリビジョンで配置して再起動します。

SQLiteの隣に作られる`*.owner.sqlite`はサービスの所有権を管理する固定ファイルです。削除しないでください。同じDBの二重起動は拒否され、強制終了時もOSがロックを解放します。DBの親ディレクトリーにも書込み権限が必要です。

## 5. HTTPSを公開する

DNSとTLS証明書を設定済みのNginxの`server`ブロックへ、[リバースプロキシ設定例](../server/nginx.conf.example)を追加します。これは証明書を含む完成した仮想ホスト定義ではありません。`X-Real-IP`は接続元IPで上書きし、Firebase認証の両ヘッダーを維持してください。APIはドメイン直下に配置します。

```sh
sudo nginx -t
sudo systemctl reload nginx
curl --fail --silent --show-error https://自分のAPIドメイン/healthz
```

Node.jsは`127.0.0.1`だけに待ち受けます。ポート8787をインターネットへ公開する必要はありません。Androidの`mobile.properties`の`apiBaseUrl`を、このHTTPS接続先に合わせます。

## API・更新周期・保存と削除

`/v1/subscription`はGETで本人の購読を照会、PUTで登録・更新、DELETEで削除します。停止は`POST /v1/subscription/stop`です。認証は`Authorization: Bearer <Firebase IDトークン>`と`X-Firebase-AppCheck: <App Checkトークン>`の両方を使い、UIDは検証済みIDトークンから決めます。FCMトークンは認証情報として扱いません。

PUT本文は`{settings, watched, fcmToken, consent: true}`です。`settings`はPC専用の`launcher_*`を除く監視設定で、本文256KiB・監視対象100件を上限とします。接続元IPは毎分120回、UIDは60回、PUTは10回までです。APIは入力・JavaScript正規表現を検証し、任意URLや利用者指定の通知本文は受け付けません。通常ログ・API応答へ生トークンと秘密鍵を含めません。

Androidの募集更新は既定60秒、板一覧は300秒、下限はどちらも60秒です。常駐スケジューラーは70秒設定を毎分cronの120秒回まで待たせません。負荷・ネットワーク・FCMによる遅延はあり、即時配送を保証する値ではありません。PC版の20秒設定には影響しません。

SQLiteにUID、通知先、同意時刻、設定・監視対象・リビジョン、取得基準・状態、通知イベントと送信待ちを保存します。初回・再開・監視対象の再追加では過去募集を通知せず、再起動後も基準を復元します。取得基準とイベント・送信待ちは同一トランザクションで保存します。締め・期限切れ、停止・条件変更では古い送信待ちを破棄します。

配信は初回を含め最大5回、60秒から最大15分の指数バックオフとジッター、FCMのRetry-Afterを考慮して期限内だけ再試行します。無効通知先と確認できたUNREGISTEREDだけで本人の購読を削除します。送信後の成功記録前に停止すると同じイベントIDを再送する場合があり、Androidも重複・期限・リビジョン・ローカル停止を確認する必要があります。

停止は設定を保持し、送信待ちを破棄します。登録削除では本人の設定・通知先・取得基準・状態・配信履歴を削除します。通常の設定は削除まで保持し、通知イベント・送信待ちは期限後の処理で掃除します。IP・UIDのレート制限はハッシュと60秒のカウンターだけを保存します。

## 障害の確認とバックアップ

| 症状 | 確認する内容 |
| --- | --- |
| 起動失敗 | Node.js 24以上、Firebase設定・秘密鍵、DBの権限、二重起動、ポート競合 |
| 購読APIが503 | Firebase公開設定、Googleへの通信、SDKワーカーの時間・同時処理上限 |
| 購読APIが401 | 両トークン、期限・署名・発行者・プロジェクト・アプリID |
| `detection_unavailable`・`execution_limit` | ビルド済みワーカー、正規表現と入力の上限、メモリ、実行時間 |
| APIは応答するが通知されない | 監視完了時刻、本人の取得・配送エラー、outboxの滞留、送信資格情報、初回基準、Android受信処理 |
| systemdで再起動を繰り返す | journalの定型エラー、メモリ上限、DBと環境ファイルのパス・権限 |

サービスの非ゼロ終了、監視完了時刻の停滞、取得・配送エラーとoutboxの滞留、ディスク容量を監視します。SDKと正規表現は別ワーカーで実行し、通信は最大5秒、判定は1秒で打ち切ります。監視回は重ねず、1回50秒の予算を持ちます。

バックアップはサービスを停止してからSQLiteを取得するなど、一貫した状態で作成します。DB・秘密鍵・バックアップはアクセスを制限した非公開領域で保管し、削除済み購読を古いバックアップから再開しないようにします。サーバー契約・配備・実Firebaseへの接続確認はこの資料追加では実行していません。
