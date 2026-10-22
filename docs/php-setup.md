# PHPサーバーのセットアップ

この手順は置換予定の現行PHP実装用です。今後は[VPS上の常駐Node.js](node-vps.md)へ移行します。新しいサーバーの導入はNode.js版の実装後に行い、このPHP手順を新構成のセットアップには使わないでください。

[README](../README.md) / [Firebaseの設定](firebase-setup.md) / [Android開発](android.md)

Android版の監視サーバーを配置する手順です。PHP APIで購読設定を保存し、毎分cronで5chの取得・募集判定・FCM送信を行います。常駐するNode.jsサーバーは不要です。PC版だけを使う場合、このサーバーは必要ありません。

PHP側の処理は実装済みですが、AndroidのFirebase SDK・受信処理は未実装です。以下でAPIとcronを準備しても、現在のAPKでプッシュ受信まで確認することはできません。`monitoringReady: false`は現状の固定値です。

## 1. 必要な環境を確認する

- Linux上のPHP CLIとPHP-FPMなどのWeb実行環境。ローカル検証済みのバージョンはPHP 8.5です。
- PHPのOpenSSL・cURL・PDO SQLite・mbstring。SQLiteは3.35以上。
- `proc_open`による子プロセス起動と実行ファイルの配置が許可されていること。
- 毎分cron、永続保存領域、一時ファイルへの書込み、`flock`が利用できること。
- 独自ドメイン等のHTTPS API接続先と、Google・5chへの外向きHTTPS接続。CA証明書とサーバー時刻も正常であること。

Ubuntuでのパッケージ導入例です。PHPのバージョン・サービス名は配布環境に合わせてください。

```sh
sudo apt update
sudo apt install php-cli php-fpm php-curl php-sqlite3 php-mbstring ca-certificates cron
php -v
php --ini
php -m
php -r 'echo (new PDO("sqlite::memory:"))->query("SELECT sqlite_version()")->fetchColumn(), PHP_EOL;'
php -r 'echo function_exists("proc_open") ? "proc_open available\n" : "proc_open unavailable\n";'
```

CLIとWeb側は異なる`php.ini`を読むことがあります。両方で拡張・`disable_functions`・一時保存先を確認してください。共有ホスティングでは管理画面と提供元の仕様を確認します。外部実行ファイルを起動できないプランでは現行の募集判定を動かせません。

## 2. 募集判定ワーカーをビルドする

サーバーと同じOS・CPU構成で動くLinux環境に、[開発環境](development.md#環境構築)のNode.js・pnpm・RustとCコンパイラーを用意し、リポジトリーのルートで実行します。

```sh
pnpm install --frozen-lockfile
pnpm build:worker
pnpm test:server
```

成果物は`server/worker/target/release/sureneco-worker`です。既存のTypeScript判定処理をQuickJSに組み込んだ単体の実行ファイルで、運用先にNode.jsやRustを入れる必要はありません。別マシンで生成する場合はCPUに加え、glibc等の実行環境も合わせてください。Windows向けの`.exe`はLinuxには配置できません。

ワーカーとPHPコードは同じリビジョンから用意します。TypeScriptの判定処理を更新した場合はワーカーも再ビルドしてください。PHP用Composer依存の導入はありません。

## 3. ファイルと保存先を配置する

以下は管理権限のあるLinuxでの配置例です。APIとcronを同じ`www-data`ユーザーで動かし、SQLite・ロック・キャッシュを共有します。既存の他サービスと分離する場合は専用ユーザーとFPM poolを用意し、以降のユーザー名もそろえてください。

| 配置先 | 内容 |
| --- | --- |
| `/srv/sureneco/server/` | リポジトリーの`server/*.php`と`server/public/index.php`。相対位置を維持 |
| `/srv/sureneco/bin/sureneco-worker` | 手順2の実行ファイル |
| `/var/lib/sureneco/state/` | SQLiteと固定ロックファイル |
| `/var/lib/sureneco/firebase-keys/` | Google公開鍵のキャッシュ |
| `/var/lib/sureneco/secrets/fcm-service-account.json` | FCM送信用のサービスアカウント秘密鍵 |
| `/etc/sureneco/cron.env` | cron用の環境変数 |
| `/etc/sureneco/run-cron.sh` | cron起動ラッパー |

リポジトリーのルートからの配置例です。更新時は稼働中のcronとAPIを止め、PHPコードとワーカーをそろえて置き換えてください。

```sh
sudo install -d -m 755 /srv/sureneco/server/public /srv/sureneco/bin
sudo install -m 644 server/*.php /srv/sureneco/server/
sudo install -m 644 server/public/index.php /srv/sureneco/server/public/index.php
sudo install -m 755 server/worker/target/release/sureneco-worker /srv/sureneco/bin/sureneco-worker
sudo install -d -o www-data -g www-data -m 700 /var/lib/sureneco
sudo install -d -o www-data -g www-data -m 700 /var/lib/sureneco/state /var/lib/sureneco/firebase-keys /var/lib/sureneco/secrets
sudo install -d -o root -g www-data -m 750 /etc/sureneco
```

SQLiteのテーブルは初回アクセス時に自動作成するため、SQLの手動投入は不要です。DBファイルだけでなく親ディレクトリーへの書込みも必要です。APIとcronを異なるユーザーで実行すると、生成ファイルの権限でアクセスできなくなることがあります。固定の`*.worker-lock`は削除せず使い続けます。

共有ホスティングでは`/srv`・`/var/lib`・`/etc`をアカウントの非公開ディレクトリーに読み替えます。Web公開ルートには次の手順の`server/public`だけを指定し、リポジトリー全体・SQLite・キャッシュ・秘密鍵を公開しないでください。

## 4. Firebaseと環境変数を設定する

先に[Firebaseの設定手順](firebase-setup.md)で、プロジェクト、Androidアプリ`sureneco.sakots`、匿名認証、App Check、FCM送信用サービスアカウントを用意します。Android用`google-services.json`をPHPサーバーに置く必要はありません。

サービスアカウントJSONは`/var/lib/sureneco/secrets/fcm-service-account.json`へ配置し、所有者を実行ユーザー、権限を600にします。このファイルは`google-services.json`とは別の秘密鍵です。

`/etc/sureneco/cron.env`を次の内容で作成します。例のプロジェクトIDを実際の値に置き換えてください。これはシェルで読み込むファイルで、PHPが自動で読む`.env`ではありません。

```sh
SURENECO_FIREBASE_PROJECT_ID='sureneco-example'
SURENECO_FCM_CREDENTIALS='/var/lib/sureneco/secrets/fcm-service-account.json'
SURENECO_SERVER_DB='/var/lib/sureneco/state/monitor.sqlite'
SURENECO_WORKER_BIN='/srv/sureneco/bin/sureneco-worker'
```

環境ファイルは`root:www-data`所有・640にします。Firebase公開設定値の取得元と、APIとcronそれぞれに必要な変数は[環境変数の対応表](firebase-setup.md#環境変数の対応)を参照してください。

API側はPHP-FPMの対象poolに次の設定を追加します。既存poolがある場合はその設定へ追記し、`env[...]`の同名項目を重複させないでください。APIにFCM秘密鍵の環境変数は不要です。

```ini
env[SURENECO_FIREBASE_PROJECT_ID] = sureneco-example
env[SURENECO_FIREBASE_PROJECT_NUMBER] = 123456789012
env[SURENECO_FIREBASE_APP_ID] = 1:123456789012:android:0123456789abcdef
env[SURENECO_SERVER_DB] = /var/lib/sureneco/state/monitor.sqlite
env[SURENECO_FIREBASE_KEY_CACHE] = /var/lib/sureneco/firebase-keys
env[SURENECO_WORKER_BIN] = /srv/sureneco/bin/sureneco-worker
```

FPM poolの`user`を`www-data`にそろえ、設定検証後にFPMを再読込みします。FPMは既定で環境変数を消去するため、SSHで`export`しただけでは設定できません。全環境を引き継ぐ設定ではなく、必要な値を明示します。[PHP-FPMの公式設定資料](https://www.php.net/manual/en/install.fpm.configuration.php)を参照してください。

## 5. HTTPSのAPIを公開する

公開ルートは **`/srv/sureneco/server/public`** です。APIはドメイン直下の`/healthz`・`/v1/subscription`・`/v1/subscription/stop`を使います。パスをPHPの`index.php`へ渡し、`Authorization`と`X-Firebase-AppCheck`ヘッダーも維持してください。

Nginx＋PHP-FPMでは、証明書を設定済みのHTTPS用`server`ブロックに次のように記載します。これはTLS設定を含む完成した仮想ホスト定義ではありません。socketのパスは対象FPM poolの`listen`と合わせます。

```nginx
root /srv/sureneco/server/public;
client_max_body_size 256k;

location / {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /srv/sureneco/server/public/index.php;
    fastcgi_pass unix:/run/php/php8.5-fpm.sock;
}
```

この例ではすべてのパスを固定の`index.php`に渡し、未知のパスはPHPが404を返します。他の`location`設定との競合、`fastcgi_params`がリクエストURI・メソッド・本文サイズを渡すこと、認証ヘッダーを削除する設定がないことを確認します。設定検証後にNginxを再読込みしてください。[NginxのFastCGI公式資料](https://nginx.org/en/docs/http/ngx_http_fastcgi_module.html)も参照してください。

共有ホスティングやApacheを使う場合も同じ公開ルート・転送先・ヘッダーを設定します。HTTPSの接続先はAndroidの`mobile.properties`に設定する`apiBaseUrl`と一致させます。CLIのPHP組み込みサーバーを本番公開には使いません。

## 6. 単発実行してからcronを登録する

`/etc/sureneco/run-cron.sh`を次の内容で作り、`root:www-data`所有・750にします。PHP CLIのパスは`command -v php`などで確認して置き換えてください。

```sh
#!/bin/sh
set -eu
umask 077
set -a
. /etc/sureneco/cron.env
set +a
cd /srv/sureneco
exec /usr/bin/php server/cron.php
```

まず運用と同じユーザーで単発実行します。

```sh
sudo -u www-data /bin/sh /etc/sureneco/run-cron.sh
```

正常終了は`{"status":"completed","monitoringReady":false}`です。購読がなければ取得・送信せず終了します。重複起動時は`status: skipped`で終了し、失敗時は非ゼロ終了と`Worker execution failed.`になります。`completed`だけでFCM認証・配送の成功とは判断できません。

`sudo crontab -u www-data -e`で、**ユーザー用crontab**に次を追加します。`/etc/crontab`等のユーザー列がある形式と混同しないでください。

```cron
* * * * * /bin/sh /etc/sureneco/run-cron.sh
```

共有ホスティングでは管理画面に毎分実行とラッパーの絶対パスを登録します。毎分起動のため、サーバーの更新下限は60秒です。PC版の既定20秒と同じ周期にはなりません。バッチは処理を終えると終了し、次回を待機しません。

## 7. 動作を確認する

```sh
curl --fail --silent --show-error https://自分のAPIドメイン/healthz
```

初回cron完了後は、`lastStartedAt`と`lastFinishedAt`が0以外のUnix時刻（ミリ秒）になり、毎分の実行で進むことを確認します。Web側とcronで時刻が共有されなければ、DBのパス・権限・実行ユーザーを確認してください。`/healthz`の成功はFirebase認証や実配送の確認ではありません。

FCM秘密鍵を読み込めるかの非送信チェックは、Firebase資料の[資格情報の読込み確認](firebase-setup.md#送信せずに資格情報の読込みを確認する)を、cronと同じユーザー・環境で実行します。資格情報が未指定なら監視・判定のみ行い、配送を試行しません。

Androidの認証・受信機能の実装後に、[接続確認](firebase-setup.md#7-android実装後の接続確認)を進めます。購読APIはFirebase IDトークンとApp Checkトークンの両方が必要です。未認証の要求を拒否したことと、有効な端末で登録・受信できたことは別に確認してください。

### ローカルでAPIだけを確認する場合

リポジトリーのルートで次を実行します。未指定時はGit除外済みの`server/data/monitor.sqlite`を使います。

```sh
php server/cron.php
php -S 127.0.0.1:8787 -t server/public server/public/index.php
```

別のターミナルから`curl http://127.0.0.1:8787/healthz`を実行します。必要な環境変数はそれぞれのプロセスに渡します。組み込みサーバーはCtrl+Cで停止します。

## 問題が起きた場合と保守

| 症状 | 確認する内容 |
| --- | --- |
| `/healthz`が404、HTMLを返す | 公開ルート、ドメイン直下のルーティング、PHPへの転送先 |
| `/healthz`が500 | PDO SQLite、DBの絶対パス、親ディレクトリーの書込み権限 |
| cronは成功するがAPIの時刻が0のまま | WebとCLIが別のDBを使っていないか |
| `authentication_unavailable` | API用Firebase環境変数、GoogleへのHTTPS、公開鍵キャッシュ権限 |
| `unauthorized` | Firebase ID・App Checkの両トークン、期限、プロジェクト・アプリの一致 |
| `detection_unavailable`、募集を判定できない | ワーカーのOS・CPU・実行権限、`SURENECO_WORKER_BIN`、`proc_open`、一時領域 |
| `Worker execution failed.` | CLIの拡張、DB・ロックの権限、環境ファイル、FCM秘密鍵の形式とプロジェクト一致 |
| 通知されない | 購読の有無・停止状態、初回取得では過去募集を通知しない仕様、cron、資格情報、Android受信処理の実装状況 |

運用開始後はcronの非ゼロ終了と最終完了時刻の停滞を監視します。バックアップではAPIとcronを停止してSQLiteを保存するなど、一貫した状態を取得してください。削除済みの購読を古いバックアップから復元しない運用も必要です。トークン・秘密鍵・募集設定の全文をログに追加せず、DBやバックアップも公開領域外で管理します。

この手順のPHPコマンドとローカルAPI経路は開発環境で確認します。運用先のNginx・FPM・TLS・cronサービスへの設定反映と、実Firebase・Androidへの配送は運用先で別途確認してください。
