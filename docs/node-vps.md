# Node.js＋自前ntfyのVPS準備

2026/10/22に採用した構成の配備・運用手順です。自動登録APIと限定管理サービスのVPS配備・公開HTTPSでの登録と権限検証、利用者による基本通知経路・状態遷移・復旧確認は完了済みです。2026/10/24には管理サービス停止／復旧・VPS再起動後の自動起動・登録保持・暗号化プッシュ配送も直接確認しました。運用・負荷確認は残っています。[進捗](server-progress.md)と[通知方式](unifiedpush-ntfy.md)を参照してください。

消灯中の受信は2026/10/24の利用者報告で成功例を確認しました。長時間消灯後の検証は保留し、ベータテストで確認します。追加検証全体を完了扱いにはしません。

接続先がまだない場合は、[API・自前ntfyの接続先を準備する](push-server-setup.md)を順に進めてください。既存ドメインのDNS設定、VPS、HTTPS証明書、サービス起動、端末接続までを記載しています。

## 1台のVPSで動かすもの

| 構成 | 役割 | 永続データ |
| --- | --- | --- |
| Node.js 24 LTS・TypeScript | 端末別認証、購読API、共有取得・判定、スケジューラー、Web Push送信 | 専用SQLite：端末認証のハッシュ、設定、通知先・暗号化鍵、取得基準、イベントと送信待ち |
| 自前ntfy | Android中継アプリとの接続維持と配送 | 認証・ACL、期限付きキャッシュ。アプリDBと分離 |
| Nginx等のHTTPSプロキシ | APIとntfyを別ホスト名で公開 | TLS証明書・更新設定 |
| systemd | 別々の専用ユーザーで起動・停止・再起動 | サービス定義・秘密情報を除いたログ |

DB・設定・鍵は公開領域外へ置き、アクセス制限と暗号化保管・バックアップを用意します。SQLiteの二重起動拒否と強制終了後の復元はローカルで、サービス停止／復旧・VPS再起動後の登録保持は実環境で確認済みです。一時バックアップの隔離復元も確認しましたが、定期・別拠点バックアップや災害復旧全体の完了ではありません。PHP・cron・サーバー用Rustコンパイルは要求しません。

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

## バックアップ・復元の運用条件

2026/10/24に一時バックアップの隔離復元を確認し、その後にOracle VPSへの暗号化バックアップと日次timerを導入しました。実データの全量読み取り・別ディレクトリーへの復元も確認済みです。[進捗](server-progress.md)に、先行した一時復元試験と別拠点バックアップの確認結果を分けて記録しています。

- アプリDBだけでなく、ntfy認証DB・ACL、設定・VAPID鍵、配備アプリ・サービス定義・TLS設定を対応の取れた時点で取得します。稼働中のSQLiteを通常のファイルコピーだけで取得せず、整合性を保証できる取得方法を使います。今回の検証は書き込みサービス停止中の取得です。
- バックアップには再表示用のntfyパスワードと秘密鍵が含まれます。公開領域・Gitへ保存せず、暗号化、別拠点保管、鍵の保管場所、アクセス権、頻度・保持世代・削除担当を決めます。同じVPS上だけのコピーはVPS喪失への備えにはなりません。
- 復元はまず隔離先で行い、SQLite整合性、鍵の対応、資格情報と読み取り権限を検証します。確認前に本番DBを上書きしたり、復元した送信待ちを本番へ配信したりしません。
- バックアップ取得後に削除・失効・更新した情報をどう反映するかを決め、古い認証や通知が復活しない状態にしてから配送を再開します。保持期限とバックアップからの削除方針も対象です。
- 自動実行の成功確認、復元訓練、失敗通知と対応担当を用意します。`Restart=on-failure`・永続journal・`/healthz`の200だけを、外部障害通知や正常な定期バックアップの証明にはしません。

### 定期・別拠点バックアップ（配備・初回復元確認済み）

2026/10/24に利用者が選択した、既存のOracle VPS・毎日03:30（日本時間）・7日保持で配備しました。restic 0.16.4で暗号化し、専用SFTPアカウントの`/data/repository`へ保存します。初回スナップショットは同日12:52:39、全量読み取りと隔離復元の確認は12:56:19に成功しました。timerは有効で、初回の定時実行予定は10/25 03:30です。予定時刻での実行実績とは区別します。

取得中だけAPI・管理サービス・ntfyを短時間停止して整合した一時コピーを作り、本番を再開してから暗号化転送します。失敗時の再開処理と予備の復旧タイマーを用意し、一時コピーは後片付けします。新しい取得の成功後に、最新スナップショットを基準に7日以内の世代を残して整理します。取得が失敗・停止している間は最後の復元可能な世代を消さないため、古い情報が7日を超えて残る場合があります。削除・失効情報の反映は復元後の配送再開前に行います。

暗号化パスワードと専用SSH秘密鍵は本番VPSのroot専用領域へ置き、復旧に必要な情報を本番VPS以外にも安全に保管します。既存の管理用SSH秘密鍵をVPSへコピーしません。SFTPアカウントは専用領域へ閉じ込め、シェル・パスワード認証・転送を許可しません。ただし送信元が侵害されるとバックアップを削除されるリスクは残り、変更不能な保管や外部の失敗通知まで整備したことにはなりません。

導入は、本番VPSで`install-vps-backup.sh prepare`と`export-backup-recovery.mjs`をsudo実行し、専用公開鍵と一時的な復旧用パスワードファイルを用意するところから進めます。この段階では本番サービスを停止せず、定期実行も有効にしません。復旧用ファイルはSSH経由で本番VPS以外の所有者限定領域へ退避し、VPS上の一時ファイルを削除します。秘密値はログ・チャット・Gitへ出しません。

次にOracleへ専用SFTPアカウントと公開鍵を設定し、既に認証した管理用SSH接続から確認したホスト鍵を本番側で固定します。初回バックアップが成功してからtimerを有効にし、Oracleから取り出した実データで整合性・鍵・資格情報・権限を確認します。ホスト鍵不一致や既存リポジトリーの認証失敗を、新規初期化で回避しません。

### 配置・確認コマンド

ソースVPSへ`scripts/install-vps-backup.sh`・`scripts/vps-backup.sh`と`server/sureneco-backup.service`・`server/sureneco-backup.timer`を、リポジトリーと同じ相対配置（または同じディレクトリーの4ファイル）で転送します。インストーラーはruntimeを`/usr/local/sbin/sureneco-backup`、unitを`/etc/systemd/system/`へroot所有で設置するため、定期実行は転送元ディレクトリーに依存しません。

```sh
# ソースVPS：準備（この段階では停止・定期実行なし）
sudo bash scripts/install-vps-backup.sh prepare
sudo node scripts/export-backup-recovery.mjs

# Oracle：ソースで発行した公開鍵だけを指定する
sudo bash scripts/install-backup-storage.sh /absolute/path/source.pub

# ソースVPS：復旧キー退避・ホスト鍵確認・Oracle設定の完了後
sudo bash scripts/install-vps-backup.sh enable /absolute/path/verified_known_hosts

# 初回保存後の全量読み取り・隔離復元・使い捨てrepoでの保持確認
# checkとverify-restoredは同じscriptsディレクトリーへ配置する
sudo bash scripts/check-offsite-backup.sh

# 運用時
systemctl list-timers sureneco-backup.timer
sudo systemctl start sureneco-backup.service
sudo journalctl -u sureneco-backup.service --no-pager
```

復旧用パスワードは本番VPS外のWindows端末の所有者限定フォルダー`.sureneco-backup-recovery-20261024/restic.password`へ退避し、一致確認後にVPS上の一時exportを削除しました。このファイルを失うと暗号化データを復号できません。Gitやチャットへ貼り付けず、端末喪失にも備えて利用者が安全に保管してください。ソースVPSを失った場合は、このパスワードとOracle管理権限で復旧用アクセスを再設定し、隔離先へ復元します。専用SSH鍵は再発行できますが、暗号化パスワードは復旧に必須です。OS・サービス用ユーザー・実行バイナリーの再構築を含む災害復旧全体は未検証です。

## OracleからのGmail障害通知

通知先・送信元は利用者指定の`sakots8000@gmail.com`、送信はOracleから`smtp.gmail.com:465`へ証明書検証付きTLSと専用アプリパスワードで行います。2026-10-24にOracleへ配置し、Linux上の13件のテスト、API・ntfy・暗号化バックアップの正常プローブを確認しました。利用者による非表示の認証情報登録と本番VPSの更新後、新しいバックアップ成功状態の受信、テストメールのSMTP受付、1分タイマーの有効・稼働、systemdサービスでの初回監視成功を確認しました。認証情報の値は表示・記録していません。

利用者からテストメールがGmailへ到達したとの報告を受け、通常送信の到達確認を完了しました。登録管理サービスを一時停止して実際のバックアップを失敗させ、サービス復帰後にOracleが失敗状態を検知し、2026-10-24 04:43:32 UTCの障害メールが利用者のGmailへ到達したことを確認しました。直後の再チェックでは同じ障害メールを再送しませんでした。その後の正常バックアップは成功し、Oracleが新しいスナップショットと成功状態を検知、04:46:02 UTCに復旧メールのSMTP受付を確認しました。利用者から復旧メールのGmail到達報告も受け、バックアップの障害検知・障害通知・正常復帰・復旧通知の実地確認を完了しました。続けた再チェックで復旧メールの重複送信はなく、API・登録管理・ntfyはすべて稼働中、毎日のバックアップタイマーも有効です。API・ntfy自体の停止によるメール通知と26時間のバックアップ未更新の実地確認は未実施で、判定・状態遷移は自動テストで確認しています。

Oracleで1分ごとにAPI・ntfyのHTTPS疎通を確認し、連続3回の接続失敗を通知対象とします。API監視処理の完了時刻が5分を超えて進まない場合も異常とし、`monitoringReady: false`は既存仕様のため判定に使いません。バックアップはOracleの暗号化スナップショットの更新が26時間を超えた場合、または送信元から届いた新しい失敗状態を検出した場合に通知します。暗号化パスワードを監視用にOracleへ複製しません。

バックアップ結果は専用SFTP鍵で非秘密の状態ファイルを送る方式とし、本番VPSからメール送信はしません。SFTP自体が失敗すると結果も届かないため、その場合は最終スナップショットから26時間を超えた時点の検知になります。同じ異常を毎分連投せず、異常が通知済みの対象が正常化したときに復旧を通知します。SMTP送信が失敗した場合は通知済みにせず、次回の監視で再送します。SMTP受付とGmail受信箱への到達は区別します。Oracle自体の停止・回線断やGoogle側の障害を別の監視元が検出する構成ではありません。

### 認証情報の登録と有効化

管理端末のPowerShellから次を実行し、Googleで作成した16文字のアプリパスワードを非表示入力します。値をチャット・コマンド引数へ貼り付けないでください。通常のGoogleログインパスワードとは別の値です。

```powershell
ssh -t Oracle "sudo /usr/local/sbin/sureneco-monitor-mail-credential"
```

認証情報はOracleの`/etc/sureneco-monitor/gmail-app-password`へroot:root・0600、親ディレクトリー0700で保存します。この操作では送信・タイマー有効化を行いません。更新時のみ同じコマンドへ`--replace`を付けます。

本番VPSにはバックアップ結果の送信スクリプトとsystemdユニットの更新を配置済みです。次は本番VPSのsudo認証が必要で、既存の検証済みホスト鍵・暗号化パスワードをそのまま使い、バックアップを1回実行します。バックアップの取得中は書き込みサービスを一時停止し、自動復帰します。

```powershell
ssh -t sureneco "sudo bash /home/sureneco/sureneco-backup-deploy/scripts/install-vps-backup.sh enable /etc/sureneco-backup/known_hosts"
```

上記の登録・更新後、Oracleで以下を実行すると、正常プローブと明示的なテストメールのSMTP受付に成功した場合だけ1分タイマーを有効にします。受信者がGmailでテストメールを確認するまでは到達確認済みとしません。

```sh
sudo bash /home/ubuntu/sureneco-monitor-deploy/scripts/install-notification-monitor.sh enable
systemctl list-timers sureneco-monitor.timer
sudo journalctl -u sureneco-monitor.service --since today --no-pager
```

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
| `SURENECO_NTFY_ADMIN_SOCKET` | 自動登録を有効にする場合だけ指定するローカルUnixソケットの絶対パス |

環境変数を渡した状態で`node dist/server/main.mjs --check-config`を実行すると設定形式だけを検証します。`Push settings loaded; not sent.`は配送成功を示しません。`Push not configured.`では通知先を登録できません。旧Firebase試作のDBを使わず、新しいDBパスを指定してください。自動移行・削除はしません。

`server/sureneco.service`と`server/nginx.conf.example`はNode.js用です。NodeSourceのapt版Node.js 24（`/usr/bin/node`）を使い、配置先・ユーザー・TLSを環境に合わせ、systemdで起動・再起動を管理します。`GET /healthz`の開始・完了時刻と送信待ちを、API疎通とは別に監視してください。現行の`monitoringReady: false`は配送成功の判定値として使わず、実配送の確認結果は[進捗](server-progress.md)を参照してください。

## ntfyの権限を準備する

ntfy用ユーザー・DBとサービスをNode.jsから分け、`deny-all`を基本にUnifiedPushの`up*`へ匿名の書き込みだけを許可します。端末のntfyアプリには個別のntfyアカウントを設定し、その端末のトピックだけに読み取り権限を付与します。ntfy管理APIを公開したり、管理者の資格情報を端末へ渡したりしません。

現在のAndroid画面は、認証済み端末の自動登録APIと、別ユーザーで動く限定管理プロセスへ接続します。中継登録で得た`up...`トピックへ読み取り権限を付与し、端末用資格情報を表示します。[配置・権限・秘密情報保管](ntfy-registration-automation.md#ローカル管理プロセスの配置)を確認してください。購読チャレンジが返るまで監視は有効になりません。停止・削除時は永続管理ジョブがntfyアカウントと権限を撤去します。

自動登録と実端末をつなぐVPS結合の基本経路、および実機の状態遷移・復旧確認は完了済みです。自動登録APIの未配置時に手動方式へ黙って切り替えません。既存の手動アカウントは自動移行・削除しないため、そのアカウントとACLの管理・撤去は運用者が行います。

## 検証の順序

1. Node.jsのビルド・テスト・型・書式・差分を確認し、認証なし・他端末・未確認チャネル・過大入力を拒否することを確認します。
2. 検証VPSでHTTPS、systemd、SQLite排他、再起動、ntfy認証・ACLと暗号化配送を確認します。
3. Android実機で画面消灯、別アプリ使用、圏外・再接続、中継停止、通知先更新、権限拒否、重複・期限・締め・停止後の抑止を確認します。
4. Node.jsとntfyを合わせたCPU・メモリ・同時接続・転送量、投稿から端末表示までの時間を測ります。1分程度は目標です。

VPS配備・基本の実配送・実機の状態遷移に加え、管理サービス停止／復旧・VPS再起動後の自動起動・登録保持・暗号化配送を確認済みです。上記は新しい環境での検証手順でもあります。長時間消灯後の検証はベータテストへ保留し、運用・負荷の確認とストア公開は未完了です。Android接続設定・署名は[Android資料](android.md)を参照してください。
