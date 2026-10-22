# API・自前ntfyの接続先を準備する

初めて接続先を用意する運用者向けの手順です。新規のUbuntu 24.04 LTS・amd64 VPS、sudo可能なSSHユーザー、管理できる独自ドメインを前提にします。VPS上の実配送は未検証です。以下を実行する際は、例のドメイン・配置先を自分の環境に置き換えてください。既存サーバーへ設定を上書きする手順ではありません。

構成・保存データ・運用上の制限は[Node.js＋VPS](node-vps.md)、Androidの開発環境は[Android資料](android.md)を参照してください。

## 1. 用意するもの

- VPS 1台と固定のグローバルIPv4。初回検証はメモリ2GB程度を出発点とし、収容人数の保証にはせず、接続数・監視数を測って調整します。Rust・Androidのビルドは開発PCで行います。
- 独自ドメインと、そのDNSレコードを変更できる権限。既存ドメインを使えれば、通知専用ドメインを新規取得する必要はありません。
- 証明書の連絡先に使うメールアドレス。
- 検証用Android端末、F-Droid版ntfy、公開接続先で再ビルドするスレ猫チェッカー。

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

[Node.js公式の24系配布一覧](https://nodejs.org/download/release/latest-v24.x/)からLinux x64のバイナリーと対応する`SHASUMS256.txt`を取得し、ファイル名とSHA-256を照合します。運用で使用する24系のパッチ版を記録してください。アーカイブを専用の`/opt/node24`へ展開します。以下の`24.x.y`は取得した実バージョンに置き換えます。

```sh
sha256sum node-v24.x.y-linux-x64.tar.xz
sudo install -d /opt/node24
sudo tar -xJf node-v24.x.y-linux-x64.tar.xz -C /opt/node24 --strip-components=1
export PATH="/opt/node24/bin:$HOME/.local/bin:$PATH"
node --version
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
sudo -u sureneco /opt/node24/bin/node /opt/sureneco/scripts/generate-vapid.mjs /etc/sureneco/vapid.json mailto:operator@example.com
sudo chown root:sureneco /etc/sureneco
sudo install -o root -g sureneco -m 640 server/server.env.example /etc/sureneco/server.env
sudoedit /etc/sureneco/server.env
```

鍵を表示する必要はありません。環境変数ファイルの内容は次の形です。

```ini
SURENECO_SERVER_PORT=8787
SURENECO_SERVER_DB=/var/lib/sureneco/monitor.sqlite
SURENECO_NTFY_ORIGIN=https://push.example.com
SURENECO_VAPID_FILE=/etc/sureneco/vapid.json
```

サービス定義をコピーし、`ExecStart`のNode.jsを今回の配置先へ変更します。

```sh
sudo install -m 644 server/sureneco.service /etc/systemd/system/sureneco.service
sudoedit /etc/systemd/system/sureneco.service
```

```ini
ExecStart=/opt/node24/bin/node /opt/sureneco/dist/server/main.mjs
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

1. VPSで端末専用の一般ユーザーを作成します。例：`sudo -u ntfy ntfy user add device001`。対話で固有のパスワードを設定し、本人だけへ渡します。管理者権限は付けません。
2. AndroidのF-Droid版ntfyで自前サーバー`https://push.example.com`とそのユーザーを設定します。サーバー設定、アカウント、UnifiedPushの既定サーバーを同じ接続先にそろえます。
3. 開発PCのGit管理外の`src-tauri/gen/android/app/mobile.properties`へ次の2行を設定し、[Android資料](android.md#androidビルドの基盤)の手順でAPKを再ビルド・インストールします。

   ```properties
   sureneco.apiBaseUrl=https://api.example.com
   sureneco.ntfyOrigin=https://push.example.com
   ```

4. スレ猫チェッカーで通知を許可し、同意後に「通知を有効にする」を押してntfyを選びます。
5. ntfyアプリで、その登録用の`up...`トピックを確認します。運用者は端末との対応を確認して、VPSで`sudo -u ntfy ntfy access device001 up実際のトピック read-only`を実行します。`up*`全体の読み取り権限は付けません。
6. ntfyの接続を再試行し、スレ猫チェッカーの「同期を再試行」を押します。チャレンジ再送には最短60秒の制限があります。「監視中」になることを確認します。

現在のアカウント・ACLの払い出しは手動です。初回はACL設定前の読み取りが拒否される可能性があり、ntfy側で再接続が必要です。この手順は実ntfyとの結合確認が未実施のため、失敗した場合は全トピックを公開せず、ntfyの登録先・本人用ACL・再接続状態を確認してください。[ntfyの認証・ACL](https://docs.ntfy.sh/config/#access-control)

接続先はビルド時に決まります。`.invalid`ホストで生成した既存の検証APKは、サーバーを作るだけでは接続先が変わりません。端末認証トークンはアプリが同意後に発行を受けるため、手動でAPKへ埋め込みません。

## 8. 準備完了と運用開始を分ける

2つのHTTPS疎通、API公開設定、ntfyの個別アカウント・ACL、Androidの所有確認まで通れば、実配送を検証する準備ができています。次に新規募集の通知、消灯中の受信、停止・削除、サービス再起動を確認します。初回の過去募集は通知しない設計です。

運用開始前に、証明書の自動更新、サービス自動起動、SQLiteとntfy認証DB・VAPID鍵の非公開バックアップ、保持期間・削除担当を決めます。surenecoで登録を削除しても、ntfyアカウント・ACLは運用者が別途撤去します。端末変更時は旧トピックのACLも整理します。確認内容と未確認項目は[進捗資料](server-progress.md)へ記録します。

| 症状 | 最初に確認すること |
| --- | --- |
| 証明書発行失敗 | DNSのA/AAAA、VPS側80番、既存CNAME、Nginxのserver_name |
| 502 | `systemctl status`、待受ポート、ループバックへのcurl |
| 通知先が拒否される | ntfyアプリの既定サーバーとAPIの`SURENECO_NTFY_ORIGIN`の一致 |
| 確認待ちが続く | 個別ACL、ntfy再接続、チャレンジ再送間隔、Android通知権限 |
| 消灯中だけ受信しない | ntfyの常駐接続と電池設定、プロキシの長時間接続 |

外部へ共有する確認結果は、2つの公開URL、OS・Node.js・ntfyのバージョン、疎通成功／失敗で足ります。秘密鍵、パスワード、Bearerトークン、端末固有の通知先URLを資料やIssueへ貼り付けません。
