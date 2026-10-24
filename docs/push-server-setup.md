# API・自前ntfyの接続先を準備する

初めて接続先を用意する運用者向けの手順です。新規のUbuntu 24.04 LTS・amd64 VPS、sudo可能なSSHユーザー、管理できる独自ドメインを前提にします。VPS上の実配送は未検証です。以下を実行する際は、例のドメイン・配置先を自分の環境に置き換えてください。既存サーバーへ設定を上書きする手順ではありません。

構成・保存データ・運用上の制限は[Node.js＋VPS](node-vps.md)、Androidの開発環境は[Android資料](android.md)を参照してください。

## 1. 用意するもの

- VPS 1台と固定のグローバルIPv4。初回検証はメモリ2GB程度を出発点とし、収容人数の保証にはせず、接続数・監視数を測って調整します。Rust・Androidのビルドは開発PCで行います。
- 独自ドメインと、そのDNSレコードを変更できる権限。既存ドメインを使えれば、通知専用ドメインを新規取得する必要はありません。
- 証明書の連絡先に使うメールアドレス。
- 検証用Android端末、F-Droid版ntfy、公開接続先で再ビルドするスレネコチェッカー。

| 用途 | この資料の例 | 接続先 |
| --- | --- | --- |
| 案内・プライバシーポリシー | `www.example.com` | 契約済みエックスサーバー |
| sureneco API | `api.example.com` | VPSのNginx → `127.0.0.1:8787` |
| 自前ntfy | `push.example.com` | 同じVPSのNginx → `127.0.0.1:2586` |

アプリへ設定する値は`https://api.example.com`と`https://push.example.com`です。どちらもパス・末尾スラッシュ・ポート・資格情報を付けない構成にします。VPSのIPアドレスだけでは、この手順のHTTPS接続先は完成しません。

## 2. DNSを設定する

ドメインの権威DNSを管理しているサービスで、次のAレコードを追加します。

| ホスト名 | 種別 | 値 |
| --- | --- | --- |
| `api.example.com` | A | VPSのグローバルIPv4 |
| `push.example.com` | A | 同じVPSのグローバルIPv4 |

エックスサーバーのネームサーバーを使用中なら、サーバーパネルの「DNSレコード設定」で対象ドメインを選びます。入力欄がドメイン部分を補う場合は、ホスト名に`api`・`push`だけを入力します。別サービスが権威DNSなら、そちらで編集します。[エックスサーバー公式のDNS設定](https://www.xserver.ne.jp/manual/man_domain_dns_setting.php)

既存サイトのA・MX・TXT・ネームサーバー設定はそのままにし、この2ホストだけを追加します。同じホストに既存CNAMEがある場合は競合を解消します。IPv6を設定・疎通確認していなければ、この2ホストにAAAAレコードは追加しません。エックスサーバー側のWeb公開用サブドメイン設定やSSL設定では、VPSの証明書は発行されません。

VPS以外のPCから確認し、両方がVPSのIPを返すまで待ちます。

```sh
nslookup api.example.com
nslookup push.example.com
```

## 3. VPSの通信と基本パッケージを準備する

以降、特記しないシェル操作はVPSで行います。VPS事業者のファイアウォールとUbuntuの両方で、SSH用ポートとTCP 80・443を許可します。SSHは自分の管理元に制限します。8787・2586は外へ開放しません。外向きはDNSとHTTPSが必要です。

```sh
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx ca-certificates curl gnupg git xz-utils
```

UFWを使う新規VPSでは、先に実際のSSHポートを許可してから有効にします。標準SSHポートの場合の例です。事業者側のコンソールからも復旧できることを確認してください。

```sh
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## 4. Node.js 24とアプリを配置する

[NodeSourceの配布リポジトリー](https://github.com/nodesource/distributions/blob/master/DEV_README.md)からNode.js 24をaptで導入します。すでにこの方法で導入済みなら、インストールは省略してバージョンとパスの確認へ進んでください。

```sh
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt update
sudo apt install -y nodejs
/usr/bin/node --version
/usr/bin/node -p 'process.execPath'
```

バージョンが`v24.`で始まり、実行パスが`/usr/bin/node`であることを確認して、運用するパッチ版を記録します。鍵ファイルは`gpg --yes`で更新するため、事前の`rm`は不要です。以後の鍵生成とsystemdも`/usr/bin/node`を使用します。

pnpmはSSHユーザーの領域へ導入します。

```sh
export PATH="$HOME/.local/bin:$PATH"
npm install --global --prefix "$HOME/.local" pnpm@12.14.0
pnpm --version
```

`node --version`が`v24.`で始まることを確認します。次の作業はSSHユーザーで行い、依存導入をrootで実行しません。配置するコミットを記録し、以後の更新でも同じビルド手順を使います。

```sh
git clone https://github.com/sakots/sureneco.git sureneco-server
cd sureneco-server
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm build:server
pnpm test:server
sudo useradd --system --user-group --home-dir /var/lib/sureneco --no-create-home sureneco
sudo install -d -o root -g root -m 755 /opt/sureneco
sudo cp -a dist node_modules package.json pnpm-lock.yaml /opt/sureneco/
sudo install -d -o root -g sureneco -m 750 /etc/sureneco
sudo install -d -o sureneco -g sureneco -m 700 /var/lib/sureneco
```

`node_modules/.pnpm`を含めてコピーします。ソースやDBをNginxの公開ディレクトリーへ置く必要はありません。ここからの`server/`・`scripts/`は、このチェックアウト内のパスです。

VAPID鍵を専用ユーザーで生成します。生成スクリプトをサービス配置先へコピーし、生成時だけ設定ディレクトリーをそのユーザーへ渡してから戻します。既存鍵は再生成・上書きしません。

```sh
sudo install -d -m 755 /opt/sureneco/scripts
sudo install -m 644 scripts/generate-vapid.mjs /opt/sureneco/scripts/generate-vapid.mjs
sudo chown sureneco:sureneco /etc/sureneco
sudo -u sureneco /usr/bin/node /opt/sureneco/scripts/generate-vapid.mjs /etc/sureneco/vapid.json mailto:operator@example.com
sudo chown root:sureneco /etc/sureneco
sudo install -o root -g sureneco -m 640 server/server.env.example /etc/sureneco/server.env
sudoedit /etc/sureneco/server.env
```

`mailto:operator@example.com`は実際の連絡先へ置き換えてください。鍵を表示する必要はありません。環境変数ファイルの内容は次の形です。

```ini
SURENECO_SERVER_PORT=8787
SURENECO_SERVER_DB=/var/lib/sureneco/monitor.sqlite
SURENECO_NTFY_ORIGIN=https://push.example.com
SURENECO_VAPID_FILE=/etc/sureneco/vapid.json
```

サービス定義をコピーします。設定例は`/usr/bin/node`を使用しています。

```sh
sudo install -m 644 server/sureneco.service /etc/systemd/system/sureneco.service
sudoedit /etc/systemd/system/sureneco.service
```

以下は`/etc/systemd/system/sureneco.service`の`[Service]`内に書く設定です。シェルへコマンドとして入力しないでください。

```ini
ExecStart=/usr/bin/node /opt/sureneco/dist/server/main.mjs
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sureneco
sudo systemctl status sureneco --no-pager
curl --fail http://127.0.0.1:8787/healthz
```

起動失敗時は`sudo journalctl -u sureneco -n 50 --no-pager`で確認します。APIの起動成功だけでは配送確認にはなりません。

## 5. ntfyを導入する

[ntfy公式のUbuntu向け配布手順](https://docs.ntfy.sh/install/#debianubuntu-repository)に従います。導入時点のリポジトリーと署名鍵を確認してください。以下は2026/10/22確認時点のamd64用です。

```sh
sudo install -d -m 755 /etc/apt/keyrings
sudo curl -fsSL -o /etc/apt/keyrings/ntfy.gpg https://archive.ntfy.sh/apt/keyring.gpg
gpg --show-keys --with-fingerprint /etc/apt/keyrings/ntfy.gpg
```

公式資料の鍵指紋`55BA 774A 6F5E E674 31E4 B6B7 CFDB 962D 4F1E C4AF`と照合後、`/etc/apt/sources.list.d/ntfy.list`へ次の1行を保存します。

```text
deb [arch=amd64 signed-by=/etc/apt/keyrings/ntfy.gpg] https://archive.ntfy.sh/apt stable main
```

```sh
sudo apt update
sudo apt install ntfy
sudo systemctl stop ntfy
sudo install -d -o ntfy -g ntfy -m 700 /var/lib/ntfy
sudo install -o root -g ntfy -m 640 server/ntfy.server.yml.example /etc/ntfy/server.yml
sudoedit /etc/ntfy/server.yml
```

`base-url`を`https://push.example.com`へ変更します。配布パッケージのサービスを`systemctl cat ntfy`で確認し、実行ユーザーが`ntfy`であることと、`/var/lib/ntfy`への書き込み権限を確認します。Node.jsのユーザー・DBとは分けます。

```sh
ntfy --version
sudo systemctl enable --now ntfy
sudo systemctl status ntfy --no-pager
curl --fail http://127.0.0.1:2586/v1/health
```

この設定は`deny-all`を基本とし、UnifiedPushの`up*`トピックに匿名の書き込みだけを許可します。読み取りは後述の本人用ACLで許可します。Firebase・外部上流・添付ファイル保存の設定は追加しません。Web PushのVAPID鍵はNode.js側のもので、ntfy設定へコピーしません。

## 6. NginxとHTTPSを設定する

`/etc/nginx/sites-available/sureneco`に、最初はHTTPの2つのserverブロックを作ります。各locationの内容には、リポジトリーの設定例を貼り付けます。下のコメントだけの状態では中継できません。

```nginx
server {
    listen 80;
    server_name api.example.com;
    # ここへ server/nginx.conf.example の location / { ... } 全体
}
server {
    listen 80;
    server_name push.example.com;
    # ここへ server/ntfy.nginx.conf.example の location / { ... } 全体
}
```

API用とntfy用の設定例を取り違えないようにします。ntfy側のWebSocket・バッファリング無効・長時間タイムアウトを維持します。両例では通知先URLをアクセスログへ残さない設定にしています。

```sh
sudo ln -s /etc/nginx/sites-available/sureneco /etc/nginx/sites-enabled/sureneco
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d api.example.com -d push.example.com --redirect
sudo nginx -t
sudo certbot renew --dry-run
```

対話でメールアドレス等を入力します。HTTPでの購読登録はせず、証明書の発行とHTTPSへのリダイレクトが完了してからアプリを接続します。証明書はVPS側で取得・更新します。[UbuntuのTLS設定](https://ubuntu.com/server/docs/how-to/security/obtain-tls-certificates/)

証明書更新用のタイマーも`systemctl list-timers --all`で確認します。VPS以外のPCから次を確認します。証明書エラーを無視する`-k`は使いません。

```sh
curl --fail https://api.example.com/healthz
curl --fail https://api.example.com/v1/push-config
curl --fail https://push.example.com/v1/health
```

`push-config`の`ntfyOrigin`が自前ntfy、`vapidPublicKey`が空でないことを確認します。503ならAPIの環境変数・VAPIDファイルの権限を見直します。`healthz`の`monitoringReady: false`は現状の実装の値で、HTTPSの失敗を意味しません。実配送の確認とは分けます。

## 7. 端末のアカウントとアプリを接続する

新しいAndroid画面は自動登録APIを必要とします。先に以下の管理サービスを配置してください。既存の`device001`などの手動アカウントは削除・移行しません。

### 限定管理サービスを追加する

VPS上のチェックアウトを今回の実装へ更新し、`pnpm install --frozen-lockfile`・`pnpm test:server`・`pnpm typecheck`を通して`dist/server`を配置します。既存DB・VAPID鍵を維持し、既存のサービス・環境設定は変更前に非公開の場所へバックアップします。

```sh
command -v ntfy
ntfy --version
sudo systemctl cat ntfy sureneco
sudo stat /etc/ntfy/server.yml /var/lib/ntfy
getent passwd ntfy
getent group ntfy
getent group sureneco-ntfy || sudo groupadd --system sureneco-ntfy
```

ntfy 2.32.0を検証済みです。`server/ntfy-admin.env.example`の実行ファイル・設定パス、`server/sureneco-ntfy-admin.service`の実行ユーザー・グループ・`ReadWritePaths`を実環境へ合わせます。APIユーザーへntfyグループ、DBの権限、sudo権限は付けません。既存ファイルがある場合は以下を再実行して上書きせず、差分を確認してください。

```sh
sudo test ! -e /etc/sureneco/ntfy-admin.env &&
  sudo install -o root -g ntfy -m 640 server/ntfy-admin.env.example /etc/sureneco/ntfy-admin.env
sudoedit /etc/sureneco/ntfy-admin.env
sudo test ! -e /etc/systemd/system/sureneco-ntfy-admin.service &&
  sudo install -m 644 server/sureneco-ntfy-admin.service /etc/systemd/system/sureneco-ntfy-admin.service
sudo install -d -m 755 /etc/systemd/system/sureneco.service.d
sudo test ! -e /etc/systemd/system/sureneco.service.d/ntfy-admin.conf &&
  sudo install -m 644 server/sureneco-ntfy-admin.conf /etc/systemd/system/sureneco.service.d/ntfy-admin.conf
sudoedit /etc/sureneco/server.env
```

APIの`server.env`へ`SURENECO_NTFY_ADMIN_SOCKET=/run/sureneco-ntfy/admin.sock`を追加します。管理サービスはntfyのユーザーで動き、共有グループ`sureneco-ntfy`へAPIサービスだけを追加してUnixソケットへの接続を許可します。管理用の環境ファイルをAPIユーザーから読めるようにしません。DBが`/var/lib/ntfy`以外ならサービスの許可パスも変更します。

```sh
sudo systemd-analyze verify /etc/systemd/system/sureneco-ntfy-admin.service /etc/systemd/system/sureneco.service
sudo systemctl daemon-reload
sudo systemctl enable --now sureneco-ntfy-admin
sudo systemctl restart sureneco
sudo systemctl status sureneco-ntfy-admin sureneco --no-pager
sudo stat /run/sureneco-ntfy /run/sureneco-ntfy/admin.sock
sudo systemctl show sureneco -p SupplementaryGroups
```

ディレクトリーは`ntfy:sureneco-ntfy`の`0750`、ソケットは同所有者の`0660`です。APIサービスの`SupplementaryGroups`が`sureneco-ntfy`を含むことを確認します。実際の接続確認は認証済み登録APIを使います。異常時にソケットを手動削除する前に管理サービスを停止してください。systemdは管理サービスの停止時にランタイムディレクトリーを撤去します。

### Androidから自動登録を確認する

1. ntfy（Google Play版・F-Droid版のいずれも可）で自前サーバーを設定します。UnifiedPushの既定サーバーも同じ接続先にそろえます。
2. 開発PCのGit管理外の`src-tauri/gen/android/app/mobile.properties`へAPIとntfyのHTTPS originを設定し、[Android資料](android.md#androidビルドの基盤)の手順でAPKをビルド・インストールします。
3. スレネコチェッカーで通知を許可し、同意後に「通知を有効にする」を押してntfyを選びます。
4. 画面に自動発行された接続先・ユーザー名・パスワードをntfyの「ユーザー管理」へ入力します。トピックを運用者へ渡す必要はありません。
5. ntfyの接続を再試行し、スレネコチェッカーの「同期を再試行」を押します。チャレンジ再送には最短60秒の制限があります。「監視中」になることを確認します。
6. 通知先変更、圏外での停止と再試行、停止受付から権限撤去完了への変化、再開、端末登録削除、管理サービス停止と復旧・VPS再起動を確認します。削除後は端末認証がなくなるため、画面の「受付済み」をACL撤去完了とはみなしません。

実VPSでの自動登録・権限分離と、利用者によるAndroid実機の基本通知経路・状態遷移・復旧確認は完了済みです。消灯中の未受信と、管理サービス停止／復旧・VPS再起動をまたぐサーバー側の確認は残っています。[進捗](server-progress.md)を参照してください。失敗時に全トピックを公開せず、管理サービスの状態、本人用ACL、ntfyのログイン先と再接続状態を確認してください。[ntfyの認証・ACL](https://docs.ntfy.sh/config/#access-control)

消灯中の受信は2026/10/24の追加報告で成功例を確認しました。長時間消灯後の検証は保留し、ベータテストで確認します。消灯中未受信の記録は以前の状態であり、追加検証全体を完了扱いにはしません。

接続先はビルド時に決まります。`.invalid`ホストで生成した既存の検証APKは、サーバーを作るだけでは接続先が変わりません。端末認証トークンはアプリが同意後に発行を受けるため、手動でAPKへ埋め込みません。

## 8. 準備完了と運用開始を分ける

2つのHTTPS疎通、API公開設定、ntfyの個別アカウント・ACL、Androidの所有確認まで通れば、実配送を検証する準備ができています。新しい環境では新規募集の通知、消灯中の受信、停止・削除、サービス再起動を確認します。既存環境では基本の実機通知・状態遷移と復旧は確認済みで、消灯中の未受信とサーバー側の復旧確認が残っています。初回の過去募集は通知しない設計です。

運用開始前に、証明書の自動更新、サービス自動起動、SQLiteとntfy認証DB・VAPID鍵の非公開バックアップ、保持期間・削除担当を決めます。自動登録APIで発行したntfyアカウント・ACLは停止・削除時に永続管理ジョブが撤去します。既存の手動アカウントは対象外のため運用者が別途撤去し、端末変更時は旧トピックのACLも整理します。確認内容と未確認項目は[進捗資料](server-progress.md)へ記録します。

| 症状 | 最初に確認すること |
| --- | --- |
| 証明書発行失敗 | DNSのA/AAAA、VPS側80番、既存CNAME、Nginxのserver_name |
| 502 | `systemctl status`、待受ポート、ループバックへのcurl |
| 通知先が拒否される | ntfyアプリの既定サーバーとAPIの`SURENECO_NTFY_ORIGIN`の一致 |
| 確認待ちが続く | 個別ACL、ntfy再接続、チャレンジ再送間隔、Android通知権限 |
| 消灯中だけ受信しない | ntfyの常駐接続と電池設定、プロキシの長時間接続 |

外部へ共有する確認結果は、2つの公開URL、OS・Node.js・ntfyのバージョン、疎通成功／失敗で足ります。秘密鍵、パスワード、Bearerトークン、端末固有の通知先URLを資料やIssueへ貼り付けません。
