# 通知サーバーの運用方針と費用

2026/10/22に、**Node.js＋VPSの監視、UnifiedPush＋自前ntfyの通知**を採用しました。現行の本番・公開アプリではFirebaseを使いません。[採用構成](unifiedpush-ntfy.md)と[進捗](server-progress.md)を参照してください。

2026/10/27にはVPS不要のPHP案を将来候補として保留しました。2026/11/11から利用者の承認によりPHP＋FCMの疎通試験を別構成で進めます。現行Node.js版のDB・認証・通知先・アプリには変更を加えません。

## 費用を抑える構成

Node.js・SQLite・ntfy・HTTPSプロキシを同じ小規模VPSにまとめます。契約済みのエックスサーバーは案内・ダウンロードリンク・プライバシーポリシーの掲載に使い、既存料金は追加費用に含めません。現時点では外部DB・Redis・複数VPSを契約しません。

追加費用の中心はVPSと必要なバックアップ・転送等です。Firebaseの利用料は見込みません。利用者にはAndroidのntfyアプリを別途導入してもらい、自前サーバーへ接続する構成です。料金例と増強判断は[人数制限を設けないVPS運用](vps-cost.md)を参照してください。

## 比較した案と採用範囲

| 案 | 判断 |
| --- | --- |
| 既存エックスサーバー＋PHP＋毎分cron＋外部ntfy | VPS・Firebaseを自前で運用しない将来候補。未実装・未検証で、当面は保留（下記参照） |
| 小規模有料VPS＋Node.js＋自前ntfy | 現行の採用構成。VPS配備・基本通知・復旧確認済み。負荷・運用全体の確認は継続中 |
| OCI Always Free | 無料対象リソースでも空き容量・アイドル回収等の条件があり、安定稼働を保証できない。現時点で採用先に指定しない |
| Cloudflare Workers Free | 現行の常駐Node.js、node:sqlite、分離ワーカーをそのまま動かす構成ではなく、ntfyの配置先も別途必要 |
| GitHub Actions定期実行 | 最短5分のため、1分程度の監視目標には使わない |

参考：[エックスサーバーの外部プログラム制約](https://www.xserver.ne.jp/support/faq/service_server_program_introduction.php)、[OCI無料枠](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)、[Workers制限](https://developers.cloudflare.com/workers/platform/limits/)、[GitHub Actions実行間隔](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule)。共用サーバーで常駐Node.js・ntfyを運用できると確認したものではありません。

## 保留するPHP＋cron版の案（2026/10/27）

- **目的**：契約済みエックスサーバーのPHP API・PHP CLI・cronで端末認証、設定保存、5ch取得、募集判定、通知送信を行い、Node.jsの実行環境と自前VPSを不要にする。端末への接続維持は外部の`ntfy.sh`とAndroidのntfy／UnifiedPushに委ねる。
- **Firebaseなしの配送**：暗号化Web Pushを`X-UnifiedPush: 1`付きで送る。Firebaseを含まない中継アプリが必要な場合はF-Droid版ntfyを使う。通常の平文ntfy投稿への置き換えはしない。
- **既存アプリへの影響**：現在の自前ntfyアカウント・読み取りACL自動発行を、外部通知先の登録・所有確認へ変更する必要がある。先に生成したNode.js版向けAABを接続先だけ変えて使えるとは扱わない。端末認証、暗号化、期限・重複抑止、停止・削除は維持する。
- **運用上の制約**：外部サービスの障害・利用条件・送信数や接続数の制限に依存する。共用PHPサーバーの送信元IPが集約される場合の制限、公開アプリの想定規模、保護トピックの利用条件は未確認。無料枠で無制限・無期限に運用できるとは保証しない。
- **安全性とプライバシー**：無料の公開トピックは端末別ACLと同等ではない。本文は暗号化し、通知先の漏えい・不正投稿・所有確認を設計する。暗号化しても通信先・時刻などのメタデータが外部事業者へ渡るため、採用時に同意・プライバシーポリシー・データセーフティも更新する。
- **現行との仕様差**：毎分cronでは70秒設定が約120秒後の処理となる場合があり、現行の秒単位スケジューラーと同等とはしない。JavaScript正規表現とPHPのPCREも互換ではない。判定コア・実行上限、cronの実行時間・重複起動防止、DB排他、障害回復と実端末の消灯中配送は採用前の検討・検証事項。
- **並行開発時の境界**：Node.js版のDB・認証・通知先・配備先に干渉させない。PHPから既存Node.js APIやntfy管理サービスへ処理を委譲する構成は「Node.js不要」とは呼ばない。

根拠：[ntfyのUnifiedPush仕様](https://docs.ntfy.sh/publish/#unifiedpush)、[Android版のFirebase・常時接続の違い](https://docs.ntfy.sh/subscribe/phone/#instant-delivery)、[外部サービスの利用制限](https://docs.ntfy.sh/publish/#limitations)、[PHP Web Pushライブラリー](https://github.com/web-push-libs/web-push-php)、[エックスサーバーのcron](https://www.xserver.ne.jp/manual/man_program_cron.php)。確認日：2026/10/27。仕様・候補の記録であり、この組み合わせの動作確認記録ではありません。

## PHP＋FCMの分離した疎通試験（2026/11/11）

- エックスサーバーのPHP 8.4.27でcurl・OpenSSL・mbstring・PDO SQLite／MySQLを確認。`egg.5ch.io`のsubject.txtはHTTP 200で641スレッド、datはHTTP 200で925レスを解析しました。`.net`はHTTP 308のため試験では追従していません。一時cronのPHP実行と、試験行の削除・既存crontabの保持も確認済みです。これらは測定時点の結果で、継続取得の保証ではありません。
- `trials/php-fcm/`に送信CLIと独立したAndroid試験アプリを置きます。この時点では認証と通知配送の疎通試験に限定しており、募集判定は下記のPHP監視試作で追加します。本番のTauri／Rust／UnifiedPushには組み込みません。
- 試験アプリIDは`sureneco.sakots.phptrial`。利用者の同意・OS通知許可を確認してFCM登録トークンを取得し、明示操作でコピーできます。受信した`connectivity_test`のイベントID・期限を確認して通知と受信記録を表示します。Google Play開発者サービスを利用できる端末が必要です。
- PHP CLIはGoogle AuthライブラリーでサービスアカウントのOAuth認証を行い、FCM HTTP v1 APIの認証確認・`validate_only`・試験通知送信を区別します。端末なしの`validate-topic`は一時トピックへの検証要求だけを送り、通知は配送しません。宛先トークン・認証トークン・秘密鍵をログや引数に出さず、認証成功・FCM受付成功・端末受信成功は別々に記録します。試験通知は有効期限5分、受信対象は別アプリIDに限定します。
- `.secrets/php-fcm/service-account.json`はサーバー用秘密鍵（0600）、`google-services.json`は試験用クライアント設定です。プロジェクトIDとアプリIDを照合し、秘密鍵はAPKに含めません。エックスサーバーのPHP試験では鍵をSSH標準入力で渡し、公開領域やcronへ保存しません。試験用受信トークンは`.secrets/php-fcm/registration-token.txt`へ保存し、チャット・Gitへ貼りません。
- ビルドは既存のGradle wrapperから独立プロジェクトを指定して実行します。FCM SDKは試験アプリだけの依存です。送信コード・依存ファイルは公開外の一時ディレクトリーへ配置し、試験後に撤去します。実機が接続されていない場合は、APK生成・FCM認証までと端末到達未確認を明示し、架空の宛先への送信を成功扱いにしません。

### 確認結果

- エックスサーバーのPHPから実際のサービスアカウントでOAuth認証に成功し、FCM HTTP v1の`validate-topic`も成功しました。検証要求だけで、端末へ通知は送っていません。試験用の送信コード・依存ファイル・クライアント設定はサーバーから撤去済みです。
- PHPの90アサーション、Android受信ポリシーの6テスト、デバッグAPKのビルドに成功しました。APKのパッケージID・署名・16KB整列と、サービスアカウント秘密鍵を含まないことを確認しました。
- ローカル配布物は`release/sureneco_php_fcm_trial_debug.apk`です。既存アプリと別にインストールできます。デバッグ署名の試験専用で、GitHub Releases・Google Playには公開していません。
- 2026/11/11に利用者から、試験APKのインストール時に「有害なアプリをブロックしました。このアプリは有害な可能性があります。このアプリをインストールするとデバイスが不正に利用される可能性があります。Playプロテクトについて詳細をご覧ください」と表示されるとの報告を受けました。スクリーンショットはなくても、この報告を導入失敗として扱います。実機でのトークン取得・通知到達は未確認のままです。

### Playプロテクトのブロック調査（2026/11/11）

- 今回の文面を、単なる「不明なアプリ」「スキャン推奨」や古いtarget SDKの警告と同一視しません。Googleの判定理由は未特定で、誤検知とは断定していません。保護機能を止めたり、別のインストール経路・アプリID・署名へ変更して検査を回避したりしません。
- 対象は`release/sureneco_php_fcm_trial_debug.apk`、アプリID`sureneco.sakots.phptrial`、versionName `1.0-trial`／versionCode `1`、minSdk 24／targetSdk 36です。デバッグ可能な試験ビルドで、署名は`Android Debug`。APK署名v2と16KB zip整列は有効で、配布用ファイルとローカルのビルド出力は同一SHA-256でした。署名が有効なことやデバッグ署名であることだけでは、警告の理由・安全性・解除を説明できません。
- APK SHA-256：`d1179aa172fd2a9e38f6401d4a1087189f4cfbf845f11cb99d97a3b6cf221b2b`。署名証明書SHA-256：`38e9772a4226afb09e02303cbfa195e8f7a59083b1d86a6235b9237452769e62`。警告対象のファイルを識別するための値で、安全性の保証ではありません。
- 実APKの要求権限はInternet、通知表示、ネットワーク状態、wake lock、FCM受信とアプリ専用の署名権限です。SMS・アクセシビリティ・他アプリの通知読み取り・他APKのインストール権限はありません。通知表示の`POST_NOTIFICATIONS`は、通知読み取りの権限とは別物です。
- 試験の自作Android／PHPコード、Manifest、公開クライアント設定の生成経路をレビューし、根拠のある脆弱性は見つかりませんでした。独自の動的コードロードやインストール処理も見つかりませんでした。ただし第三者SDKのバイナリーを全面解析したものではなく、端末へ渡ったファイルの同一性・Google側の分類・端末での安全性を確認したという意味ではありません。接続された実機はありません。
- 次は、手元の警告対象APKのハッシュを照合し、開発者が[Googleの警告別ガイダンス](https://developers.google.com/android/play-protect/warning-dev-guidance)に沿って対象APK・SDKを確認したうえで、必要なら[Play Protectの分類に対する審査申し立て](https://support.google.com/googleplay/android-developer/contact/protectappeals)を行います。APK・署名情報・上記の報告文面を対象の識別に使い、サービスアカウント秘密鍵・FCM受信トークン・OAuthトークンは提出資料に含めません。APKの外部提出・一般公開・Google Playへのアップロードは今回行っていません。
- ブロックが解消し、安全に導入できる状態を確認するまでは、この端末へのインストール、トークン取得、実宛先への送信試験を保留します。正式署名・Play内部テストへの変更だけで警告が消えるとは保証しません。現行Node.js版の稼働・登録と試験前のPHP／FCM認証確認結果は変更しません。

### 試験の実行順序

プロジェクトのルートで実行します。ComposerとPHP 8.2以上、AndroidビルドにはJava 21・Android SDKが必要です。

```sh
composer install --working-dir=trials/php-fcm/php
php trials/php-fcm/php/bin/fcm-trial.php auth \
  --credentials=.secrets/php-fcm/service-account.json \
  --client-config=.secrets/php-fcm/google-services.json
php trials/php-fcm/php/bin/fcm-trial.php validate-topic \
  --credentials=.secrets/php-fcm/service-account.json \
  --client-config=.secrets/php-fcm/google-services.json
ANDROID_HOME="$PWD/.android-sdk" src-tauri/gen/android/gradlew \
  -p "$PWD/trials/php-fcm/android" :app:assembleDebug
```

`auth`はOAuth認証だけ、`validate-topic`は端末へ送らないFCM要求の検証です。どちらも端末への通知到達を示しません。鍵は公開領域へ置かず、送信CLIはPHP CLI専用でWebからの実行を拒否します。

以下は、上記のブロック調査・必要な修正またはGoogle側の再審査を経て、安全に導入できることを確認した後の手順です。現時点で利用者の端末では導入を再開しません。再開後は「スレネコ PHP・FCM試験」を開き、同意欄をチェックして「同意して通知試験を開始」を押し、通知を許可してください。「登録トークンを機密クリップボードにコピー」からコピーし、開発端末の`.secrets/php-fcm/registration-token.txt`へ保存します。このファイルは`chmod 600 .secrets/php-fcm/registration-token.txt`で0600にしてください。トークンはチャット・Gitへ貼らず、保存できたことだけを伝えてください。現行版のUnifiedPush通知先やntfy資格情報を宛先に流用しません。

```sh
php trials/php-fcm/php/bin/fcm-trial.php validate \
  --credentials=.secrets/php-fcm/service-account.json \
  --client-config=.secrets/php-fcm/google-services.json \
  --registration-token-file=.secrets/php-fcm/registration-token.txt
php trials/php-fcm/php/bin/fcm-trial.php send \
  --credentials=.secrets/php-fcm/service-account.json \
  --client-config=.secrets/php-fcm/google-services.json \
  --registration-token-file=.secrets/php-fcm/registration-token.txt
```

送信後はアプリの受信記録とOS通知を確認します。FCM側の受付成功だけで「端末に届いた」と判断しません。試験停止時はアプリ側も停止し、不要になった受信トークンのファイルを削除します。

## PHP＋cronの募集監視試作（2026/11/22）

端末導入の再開条件は維持し、先にサーバー側を分離して進めます。PHP CLIが5ch麻雀板の候補一覧と指定スレッドのDATを取得し、現行版と同じTypeScript判定を専用QuickJSプロセスで実行します。Node.jsとRustはビルド時だけ必要です。配備先ではPHPとLinux用の判定バイナリーを使います。共有ホスティングへの配置と実行可否はこのローカル検証と区別します。

試作CLIにはPHP 8.2以上、curl・mbstring・PDO SQLiteと`proc_open`が必要です。ComposerとFCMの設定は不要です。判定バイナリーを既定の`trials/php-fcm/worker/target/release/`から移す場合は、実行ファイルの絶対パスを`SURENECO_PHP_WORKER_BIN`に指定してください。

```sh
node scripts/build-php-worker.mjs
php trials/php-fcm/php/bin/monitor.php list
php trials/php-fcm/php/bin/monitor.php scan THREAD_ID /absolute/private/monitor.sqlite loose
```

`scan`のモードは省略時`regex`（通常）、`loose`で緩めです。保存先には公開領域外の既存の所有者専用ディレクトリー（0700）を用い、DBと実行ロックは同じディレクトリーに0600で配置します。初回取得は履歴を基準として記録するだけで、次回以降は基準より後の募集をJSONで返します。参照を含め全DATを判定し、締め済み・期限切れの募集は除外します。失敗時は取得位置を進めず、同じDBを使う実行の重複は拒否します。毎分cronから呼び出す場合も、同じDBを継続使用してください。

`list`は`threads`、`scan`は`threadId`・`baseline`・`lastPost`・`recruitments`を返します。募集の`expiresAt`はUnixミリ秒です。壊れたDATや前回より短いDATは失敗として扱い、取得位置を維持します。新着の検出結果は、標準出力を受け取れなくても失われないよう、取得位置と同じSQLiteトランザクションで`detected_recruitments`に保存します。スレッドIDとレス番号で重複を防ぎ、成功した監視回で期限切れを削除します。保存済みの行を最新DATでの再確認なしに配送しません。

次回の正常な取得時には、保存済み募集も最新DATで再判定し、元募集や追記の締めを確認したものを削除します。取得に失敗した回は送信しません。

ローカルでは`php trials/php-fcm/php/tests/monitor.php`で、実際の判定プロセスと一時SQLiteを使用して初回基準、新着の半荘募集、締め・期限切れと取得失敗からの復旧を確認しました。実際の5ch取得でも候補3件と指定スレッドのDAT 758レスを読み込み、初回に募集を出力しないことを確認しました。

### 募集通知のFCM接続

`list`・`scan`は引き続きFCM鍵やトークンを読みません。通知を送るのは明示的な`deliver`だけです。下記はPlayプロテクトのブロック解消と端末への導入を確認した後の試験手順です。公開設定API・端末の自動登録は行いません。

```sh
composer install --working-dir=trials/php-fcm/php
php trials/php-fcm/php/bin/monitor.php deliver THREAD_ID /absolute/private/delivery.sqlite loose \
  /absolute/private/service-account.json /absolute/private/google-services.json \
  /absolute/private/registration-token.txt
```

`deliver`には試験端末1台専用の新しいDBを使い、同じ端末・フィルターで継続します。初回は過去のレスを送らず、2回目以降は最新DATで再確認した募集を古い順に1回につき最大1件送信します。再判定からFCMの応答・保存まで同じDBの実行ロックを保持します。FCM受理後にだけ配送済みとして待ち行から削除し、失敗時は次回実行時に再判定します。受理直後に切断・停止した場合は再送され得ますが、同じイベントIDを使い、初回試行で固定した期限を再送で延長しないことで端末側の重複を抑えます。

通知は試験アプリIDに限定し、FCMのTTLと端末が受信を受け入れる期限は募集の期限を超えない最大300秒です。募集通知を受信するには対応した試験アプリが必要です。既存の疎通試験メッセージは従来の300秒のままです。FCM受理と実機の受信は別に扱います。Playプロテクトの解除・再審査結果は未確認のため、今回はAPK再配布・実端末送信・cron登録・本番切替を行いません。

ローカルでは実判定ワーカーと一時SQLiteで、最新DATを取得できない回の送信抑止、締め済みの除外、受理済みの再送防止、失敗後の再試行とその打ち切りを確認しました。FCM HTTP v1の要求本文は隔離HTTPテストで、募集通知の期限と重複抑止はAndroidのJVMテストで確認しました。実際のFCMへの送信と端末表示は未確認です。


## 1分程度の通知と負荷

Androidの更新間隔は既定60秒・下限60秒、板一覧は既定300秒を維持します。投稿から次の監視まで通常0〜60秒程度で、取得・判定・ntfy・端末の処理時間が加わります。通信・電池制限・停止を含め「必ず60秒以内」の配送は保証しません。

同じdatを60秒ごとに取得すると30日で43,200回、板一覧の300秒更新は8,640回です。同じ板・スレッドは購読者間で共有取得します。平均200KiBのdatを毎回全取得した場合、圧縮・差分を考慮しない概算で1スレッド当たり約8.2GiB/月です。これにntfyの接続維持・配送・再接続も加えて実測します。

登録人数の固定上限を設けない方針と、一定料金で無限の接続・判定・配信を処理できることは別です。処理の遅れ、送信待ち、同時接続、メモリ、転送量を測り、最適化・増強を判断します。VPSの契約・配備は今回行っていません。
