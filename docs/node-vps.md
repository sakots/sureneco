# Node.js＋自前ntfyのVPS準備

2026/10/22に採用した構成です。Node.jsのAPI・監視・Web Push送信と設定例を実装しました。以下は配備準備の手順です。運用VPSと実ntfyでの結合検証は未実施で、ローカルテストの成功と区別します。[進捗](server-progress.md)と[通知方式](unifiedpush-ntfy.md)を参照してください。

## 1台のVPSで動かすもの

| 構成 | 役割 | 永続データ |
| --- | --- | --- |
| Node.js 24 LTS・TypeScript | 端末別認証、購読API、共有取得・判定、スケジューラー、Web Push送信 | 専用SQLite：端末認証のハッシュ、設定、通知先・暗号化鍵、取得基準、イベントと送信待ち |
| 自前ntfy | Android中継アプリとの接続維持と配送 | 認証・ACL、期限付きキャッシュ。アプリDBと分離 |
| Nginx等のHTTPSプロキシ | APIとntfyを別ホスト名で公開 | TLS証明書・更新設定 |
| systemd | 別々の専用ユーザーで起動・停止・再起動 | サービス定義・秘密情報を除いたログ |

DB・設定・鍵は公開領域外へ置き、アクセス制限と暗号化保管・バックアップを用意します。SQLiteの二重起動を拒否し、VPS再起動・強制終了後もカーソルと送信待ちを復元する計画です。PHP・cron・サーバー用Rustコンパイルは要求しません。

## 配備前に決めること

- VPSの契約先・容量・運用予算。低価格候補は[費用比較](vps-cost.md)を参照。既存エックスサーバーは掲載用に使います。
- APIとntfyのHTTPSホスト名、DNSと証明書。ntfyの長時間接続と再接続をプロキシ越しに確認します。
- Node.js・ntfyの検証済みバージョン、更新担当、DBと秘密鍵の保管・バックアップ先。
- 自前ntfyの端末別認証・トピックACLと中継アプリの設定経路。匿名の全トピック読み取りや全端末共通の管理資格情報を避けます。
- ファイル記述子、プロキシの接続数、ntfyの購読数・配信頻度・キャッシュ上限。Node.jsから同じ送信元で多数配信するときのレート制限も確認します。

ntfyの公式設定は[UnifiedPush用ACL](https://docs.ntfy.sh/config/#example-unifiedpush)を参照してください。Firebase連携・外部上流への転送は有効にしません。`server/ntfy.server.yml.example`と`server/ntfy.nginx.conf.example`を設定の出発点にし、採用バージョンで動作確認します。

## API・更新周期・保存と削除

端末認証・購読のAPI本文とチャネル所有確認は[通知方式の設計](unifiedpush-ntfy.md#認証と通知先の登録)を参照してください。通知先のURLをAPI認証にせず、チャレンジ確認前には募集を送りません。任意URL・内部IP・リダイレクトを拒否します。

Androidの募集更新は既定60秒、板一覧は既定300秒、両方の下限は60秒です。毎分cronに丸めず、処理の重複を防ぎます。PC版の20秒設定は維持します。同じ板・スレッドを端末間で共有取得し、既存TypeScriptコアを時間・メモリ・入出力上限付きワーカーで実行します。

設定・通知先・端末認証は本人の削除まで保存し、通知イベント・送信待ち・重複排除記録は有効期限後に掃除します。停止は端末で先に抑止し、サーバーの未送信を止めます。購読削除は本人の設定・通知先・取得基準・配信履歴を消し、端末削除は認証情報も消します。ntfy側のチャネル・資格情報も対応させ、バックアップの削除方針を含めて資料化・検証します。鍵・生トークン・通知先URL・auth secret・NG全文は通常ログに出しません。

## ビルド・鍵・起動

開発用Node.js 24 LTSで依存を導入してビルドします。PC向け配布物へサーバーを同梱するものではありません。

```sh
pnpm install --frozen-lockfile
pnpm build:server
pnpm test:server
```

VAPID鍵を、アプリ利用者へ配らない専用ファイルに生成します。次の絶対パスと連絡先は配置先に合わせて変更してください。既存ファイルは上書きせず、鍵は標準出力へ出しません。

```sh
node scripts/generate-vapid.mjs /absolute/private/vapid.json mailto:operator@example.com
```

`server/server.env.example`を非公開の`/etc/sureneco/server.env`へ配置し、次を設定します。ファイルを読む権限はNode.jsサービスのユーザーだけに与えます。

| 変数 | 内容 |
| --- | --- |
| `SURENECO_SERVER_PORT` | ループバックで待ち受けるポート。既定8787 |
| `SURENECO_SERVER_DB` | 非公開の永続SQLiteパス |
| `SURENECO_NTFY_ORIGIN` | 自前ntfyのHTTPS origin。パス・末尾スラッシュなし |
| `SURENECO_VAPID_FILE` | 生成したJSONの絶対パス |

環境変数を渡した状態で`node dist/server/main.mjs --check-config`を実行すると設定形式だけを検証します。`Push settings loaded; not sent.`は配送成功を示しません。`Push not configured.`では通知先を登録できません。旧Firebase試作のDBを使わず、新しいDBパスを指定してください。自動移行・削除はしません。

`server/sureneco.service`と`server/nginx.conf.example`はNode.js用です。Node.js 24の実パス、配置先、ユーザー、TLSを環境に合わせ、systemdで起動・再起動を管理します。`GET /healthz`の開始・完了時刻と送信待ちを、API疎通とは別に監視してください。`monitoringReady: false`は実配送が未確認のため維持しています。

## ntfyの権限を準備する

ntfy用ユーザー・DBとサービスをNode.jsから分け、`deny-all`を基本にUnifiedPushの`up*`へ匿名の書き込みだけを許可します。端末のntfyアプリには個別のntfyアカウントを設定し、その端末のトピックだけに読み取り権限を付与します。運用者がntfyの`user`・`access`コマンドで払い出す方式を初期の手順とし、アプリからntfy管理APIを公開したり、管理者の資格情報を端末へ渡したりしません。

端末で中継登録すると、その端末用の`up...`トピックが作られます。ntfyアプリ側で対象トピックを確認して本人の読み取りACLを設定し、スレネコアラートで同期を再試行します。購読チャレンジが返るまで監視は有効になりません。トピック・アカウントの作成、更新、失効時のACL撤去を検証環境で確認してください。サーバー登録削除はsurenecoのデータを削除しますが、ntfyアカウントの作成・削除は運用者の作業です。この払い出し手順の実ntfyでの確認は未実施です。

例として`ntfy access 個別ユーザー 対象のupトピック read-only`で読み取りを付与します。全員へ`up*`の読み取りを許可せず、入力するユーザー・トピックが本人のものか確認します。具体的なコマンド引数と設定パスは[ntfy公式設定](https://docs.ntfy.sh/config/#access-control)を採用バージョンで確認してください。

## 検証の順序

1. Node.jsのビルド・テスト・型・書式・差分を確認し、認証なし・他端末・未確認チャネル・過大入力を拒否することを確認します。
2. 検証VPSでHTTPS、systemd、SQLite排他、再起動、ntfy認証・ACLと暗号化配送を確認します。
3. Android実機で画面消灯、別アプリ使用、圏外・再接続、中継停止、通知先更新、権限拒否、重複・期限・締め・停止後の抑止を確認します。
4. Node.jsとntfyを合わせたCPU・メモリ・同時接続・転送量、投稿から端末表示までの時間を測ります。1分程度は目標です。

契約・課金・デプロイ・公開は未実施です。Android接続設定・署名は[Android資料](android.md)を参照してください。
