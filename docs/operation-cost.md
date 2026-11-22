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

### 実機デバッグの再開（2026/11/22）

- 利用者から、Playプロテクトを有効にしたままブロックが解消して導入できたとの報告を受けました。Googleの審査結果・分類理由をこちらで確認したという意味ではありません。
- USBデバッグを承認したPixel 7 Proで、試験アプリ`sureneco.sakots.phptrial`の導入・起動・利用同意・FCM登録とOS通知権限を確認しました。既存PHP送信CLIから、アプリ表示中とホーム画面へ戻した状態で疎通通知を各1件送信し、FCM受理・端末受信記録・OS通知のeventId一致と、実画面の「通知を表示しました」を確認しました。本体のアプリ・通知先・本番サーバーは変更していません。
- WindowsではWSLのUbuntu-26.04とPHP CLIを使用し、既存のUnix秘密ファイル権限チェックを維持しました。秘密鍵は標準入力、宛先は同意済みのデバッグアプリからメモリー上で読み取り、Linuxの所有者限定一時ファイル（0600）を経由して試験後に削除しました。トークンをホストのファイル・チャット・Gitへ残していません。非秘密の証跡は`release/php-fcm-device-debug/2026-11-22.json`です。自然放置による長時間のDoze・実5ch新着募集からの配送・常設cronの長期運用は未確認です。
- 追加の消灯試験では、USB給電中に常時表示（AOD）を一時抑止し、送信直前・受信後ともDisplayの`mScreenState=OFF`を確認しました。PHPから疎通通知を1件送信し、端末の受信記録とOS通知のeventIdが一致し、「通知を表示しました」と記録されたことを確認しました。Powerのwakefulnessは`Dozing`ですが、device-idleは`ACTIVE`／`mLightState=ACTIVE`で、長時間放置によるDozeの検証ではありません。一時抑止を解除して画面の復帰を確認し、非秘密の証跡を`release/php-fcm-device-debug/2026-11-22-screen-off.json`へ保存しました。
- Deep Dozeの追加試験では、USB接続は維持したまま`cmd battery unplug`で未給電を模擬し、画面をオフにして`cmd deviceidle force-idle deep`を実行しました。試験アプリは恒久的な省電力除外に登録されておらず、除外設定も変更していません。送信前・受信後とも`mState=IDLE`・`mScreenOn=false`・`mCharging=false`のまま、PHP疎通通知1件の端末受信とOS通知のeventId一致を確認しました。試験後に`unforce`と`battery reset`を実行し、強制状態false・通常状態ACTIVE・実際の給電状態への復帰を確認しました。証跡は`release/php-fcm-device-debug/2026-11-22-deep-doze.json`です。これは開発コマンドで強制したDeep Dozeの検証で、自然放置による長時間試験とは区別します。
- 実5chの2スレッドを専用DB・緩めフィルタ・60秒間隔で15分間監視しました。初回は通知せず、取得エラーなしで30レスの増加を確認しましたが、対象の新着募集がなく実配送には到達しませんでした。履歴の取得位置や投稿時刻は改変せず、試験用の5ch投稿も行っていません。証跡は`release/php-fcm-device-debug/2026-11-22-live-delivery.json`です。
- 利用者の了承により、入力だけを隔離した試験DATへ置き換え、実際のRecruitmentMonitor・判定ワーカー・SQLite・Sender・FCM・Pixel 7 Proを接続しました。初回の基準レスで送信0件、次の「3人半荘 13589」でレス2の検出・送信前のキュー保存・実FCM送信1件・端末受信・OS通知のeventId／レス番号／部屋ID一致を確認しました。受理後のキューは0件、同じDATの再取得も送信0件でした。入力は架空で、本物の新着取得とは区別します。秘密情報と専用DBは試験後に削除し、非秘密の証跡を`release/php-fcm-device-debug/2026-11-22-recruitment-fixture.json`へ保存しました。本体・本番サーバー・cronは変更していません。

### エックスサーバーの一時cron試験（2026/11/22）

- 利用者の承認により、実際のエックスサーバーのcronで募集配送経路を確認しました。PHP 8.4.28とcurl・OpenSSL・mbstring・PDO SQLite・`proc_open`を確認し、glibc 2.28のホストへx86_64 Linux static musl判定ワーカーを配備しました。配備先で実際の5ch候補4件の取得・判定にも成功しました。サーバー上にNode.jsやRustのビルド環境は追加していません。
- 公開領域外の所有者限定ディレクトリー（0700）、FCM鍵・宛先（0600）と専用DBを使い、実cronの60秒間隔3回で、初回基準の送信抑止・架空の新着募集1件の実FCM配送・同じDATの再取得時の再送抑止を確認しました。配送前のSQLite保存、受理後の待ち行削除、Pixel 7 Proの受信記録とOS通知のeventId／レス番号／部屋ID一致を確認しています。入力は隔離した試験DATで、本物の新着取得とは区別します。
- cron実行はPHP・判定ワーカーを絶対パスで指定し、`umask 077`・限定PATH・`flock`・45秒の実行上限を使用しました。試験用cronは期限付きとし、終了後に自分の1行と鍵・宛先・DBを含む一時領域を撤去して、試験前後のcrontabの存在状態・SHA-256一致を確認しました。常設cron・長期運用・再起動後の復旧は未確認で、既存Node.js本番は変更していません。証跡は`release/php-fcm-device-debug/2026-11-22-cron-verification.json`です。

### PHP監視の常設構成（2026/11/22）

- 利用者の指定により、雀魂スレッド候補を自動追跡し、緩めフィルタでこの端末のPHP試験アプリへ配送します。候補一覧は300秒間隔、cronは毎分実行します。新しいスレッドは初回の履歴を基準とし、過去レスを一括送信しません。既存Node.js版は変更せず、両方で監視すれば二重通知になり得ます。
- コード・FCM鍵・端末宛先・DB・状態ファイルは公開領域外の所有者限定領域に常設します。実行排他と実行時間上限、候補・取得位置の永続化、通知失敗後の再判定、秘密情報を含まない状態確認、一時停止・再開を備えます。停止・再開は取得位置を消しません。トークンが変わった場合は宛先ファイルの更新が必要で、端末の自動再登録APIは追加しません。
- 常設先はエックスサーバーとし、専用のcron行だけを追加します。既存cronとNode.jsのDB・設定・通知先には触れません。無関係なcronの上書きや常設データの自動削除は行いません。
- エックスサーバーの常設先へ配備し、実データの候補2件で取得・判定が正常完了しました。実cronで一時停止中のハートビート・取得0件・送信0件とDB取得位置の不変を確認し、再開後も取得位置を保持して正常な監視回が完了しました。専用cron行は有効なまま残し、既存行の保持も確認しました。試験DATや試験用の自動撤去処理は常設先へ配置していません。
- 永続監視の回帰35アサーションとCLIの終了コード・秘密情報抑止・再開成功の回帰ケースが成功しました。配備したコードは`7cc675255ad171ac29ae13171dc0599623680222`、非秘密の配備証跡は`release/php-fcm-device-debug/2026-11-22-permanent-deployed.json`です。確認時点では送信待ち・監視エラーとも0件ですが、本物の新着募集の到着、長期安定性やホスト再起動後の復旧を確認したという意味ではありません。
- 常設監視で使うAndroid試験APKを`release/sureneco_php_fcm_trial_20261122_debug.apk`へ生成しました（1.0-trial／versionCode 1、デバッグ署名）。受信ポリシーの7テスト、APK署名、ZIPの16KB整列、サービスアカウント秘密情報の非同梱を確認しました。接続端末の既存APKと署名証明書が一致しています。今回は端末へのインストールやGitHub／Google Play公開は行っていません。SHA-256は`9078526e5210fc79f78eb52d724c5d26a951103fbdd875473f1e924b4d29eb81`です。上書き導入で既存データを保持し、削除・再インストールなどでFCMトークンが変わった場合は常設サーバー側も更新してください。

接続先のシェルでは、常設ディレクトリーを`ROOT`に指定して操作します。

```sh
ROOT=/home/ACCOUNT/.sureneco-php
/usr/bin/php8.4 "$ROOT/php/bin/service.php" status "$ROOT"
/usr/bin/php8.4 "$ROOT/php/bin/service.php" pause "$ROOT"
/usr/bin/php8.4 "$ROOT/php/bin/service.php" resume "$ROOT"
```

`pause`は進行中の監視が終わるまで同じ実行ロックを待ち、停止完了後の新たな取得・送信を抑止します。cron行とDBは残り、再開時は取得位置を継続します。鍵や宛先を更新するときも一時停止し、所有者限定の一時ファイルから原子的に差し替えて再開してください。端末の再インストール・FCMトークン変更時は`ROOT/secrets/registration-token.txt`の更新が必要です。公開HTTPの管理画面や端末の自動登録APIはありません。

### Androidからの監視スレッド選択

PHP試験アプリで候補一覧を表示し、通知対象をスレッドごとに切り替えます。設定APIはHTTPSと専用のBearer認証を必須とし、FCM送信用鍵とは分離します。既存の監視対象を初期選択として保持し、その後に見つかった候補はオフで追加します。オンにしたスレッドは既存のレスを基準にし、過去分を送信しません。VPS版には影響しません。

配備時は新コードの初回cron実行より前に `/usr/bin/php8.4 "$ROOT/php/bin/service.php" provision-selection "$ROOT"` を実行します。公開領域に置くのは `trials/php-fcm/php/public/selection.php` だけです。Web側のPHPはcronと同じアカウントで実行し、サーバー側で `HTTPS`、`HTTP_AUTHORIZATION`（または `REDIRECT_HTTP_AUTHORIZATION`）、`SURENECO_PHP_WORKER_BIN=$ROOT/bin/sureneco-php-worker` が利用できるようにします。非公開の `ROOT` はWeb側の `SURENECO_PHP_ROOT` で明示できます（既定は `$HOME/.sureneco-php`）。

Androidの「通知対象スレッドを選択」は、端末でFCM登録済みなら `https://oekakibbs.moe/sureneco-php/selection.php` から専用トークンを自動取得します。URLやトークンを手入力する必要はありません。サーバーに登録済みのFCM宛先だけが交換できます。交換にはFCMトークン自体ではなく、用途を固定したSHA-256証明値をHTTPSのリクエスト本文で使います。この証明値も認証情報なので記録しません。未登録・再登録直後に一致しない場合は、先にサーバーのFCM宛先を更新する必要があります。
オン操作は最新DATの取得に成功してから保存し、取得失敗時はオフのままです。監視と競合した場合は監視回終了後に再読み込みして操作してください。一覧から外れたスレッドは、再出現してもオフです。

エックスサーバーで公開先を `oekakibbs.moe` へ移し、旧URLと旧選択トークンを無効にしました。接続中のPixel 7 ProのFCM登録情報で専用トークンの取得と一覧取得が成功し、未登録の証明値は拒否されることを確認しました。既存の選択2件・取得DB・crontabを保持し、切替後のcronでも2件を正常に監視しました。新APKは `release/sureneco_php_fcm_trial_auto_selection_debug.apk` です。実機への上書きインストールは行っていません。

PHP版Androidも「スレッド」「友人戦募集」「設定」の3画面を使います。募集画面は通知済みでも期限内なら表示し、取得位置や未送信キューとは分離します。設定は監視間隔、募集フィルタと通知の開始・停止を扱い、VPS専用のntfy資格情報は表示しません。

募集一覧・監視設定APIを `c6fb253b6b` でエックスサーバーへ配備しました。既存のURL・認証・スレッド選択・設定値・crontabを保持。認証付き一覧取得、設定の既存値での保存と不正値の拒否、cron再開後の募集履歴テーブル作成を確認しました。配備直後の募集一覧は0件で、次回以降の実検出から表示します。三画面対応の試験APKは `release/sureneco_php_fcm_trial_dashboard_debug.apk` です。

### PHP版の一般公開に向けた構成

正式版のAndroidアプリIDは `sureneco.sakots.php` とし、デバッグ署名の試験版とは別に配布します。通知の利用は招待不要とし、通知許可と利用者の同意を得た端末が、FCMで届く一度限りの短命な確認値を返して登録します。登録後はFCM宛先とは別の端末資格情報で認証し、監視対象・設定・取得位置・通知キューを端末ごとに分離します。停止・削除は当該端末にだけ作用します。

登録試行に上限を設け、最大16端末・各端末3スレッドとします。同一監視回の候補・DAT取得は共有します。エックスサーバーの `https://oekakibbs.moe/sureneco-php-public/service.php` と専用DB・毎分cronに配備しました。Pixel 7 ProとAndroidエミュレーターの登録、隔離DATによる監視対象の分離と選択端末へのFCM実配送を確認しました。既存の試験版とVPS版は変更していません。

正式APKの更新には同じ署名鍵が必要です。署名用の `android-release.p12` とパスワードファイル `android-release.pass` は `.secrets/php-fcm/` に保管し、署名鍵のバックアップは別の安全な場所へ保存してください。Firebaseの `google-services-release.json` は正式アプリ用のクライアント設定であり、FCMサービスアカウント秘密鍵は端末に配布しません。

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

2026/11/22に上記の導入再開条件を利用者へ確認し、接続した実機で試験を再開しました。「スレネコ PHP・FCM試験」を開き、同意欄をチェックして「同意して通知試験を開始」を押し、通知を許可してください。「登録トークンを機密クリップボードにコピー」からコピーし、開発端末の`.secrets/php-fcm/registration-token.txt`へ保存します。このファイルはUnixでは0600、Windowsでは所有者限定ACLにしてください。トークンはチャット・Gitへ貼らず、保存できたことだけを伝えてください。現行版のUnifiedPush通知先やntfy資格情報を宛先に流用しません。

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

通知は試験アプリIDに限定し、FCMのTTLと端末が受信を受け入れる期限は募集の期限を超えない最大300秒です。募集通知を受信するには対応した試験アプリが必要です。既存の疎通試験メッセージは従来の300秒のままです。FCM受理と実機の受信は別に扱います。この機能の実装時点ではPlayプロテクトの解除・再審査結果が未確認だったため、APK再配布・実端末送信・cron登録・本番切替は行いませんでした。2026/11/22の実機再開後の結果は上記に記録しており、疎通通知の受信と実際の募集監視からの配送は区別します。

ローカルでは実判定ワーカーと一時SQLiteで、最新DATを取得できない回の送信抑止、締め済みの除外、受理済みの再送防止、失敗後の再試行とその打ち切りを確認しました。FCM HTTP v1の要求本文は隔離HTTPテストで、募集通知の期限と重複抑止はAndroidのJVMテストで確認しました。

端末の準備を待たずに、募集通知と同じ形式を実際のFCMに検証させるには、以下を使います。架空の募集、ランダムな試験トピックと`validate_only`を使用します。端末トークンの指定は拒否し、監視DB・5chの投稿は参照しません。`validated`はFCMがリクエストを受理したことだけを示し、通知送信や端末表示は示しません。

```sh
php trials/php-fcm/php/bin/fcm-trial.php validate-recruitment \
  --credentials=.secrets/php-fcm/service-account.json \
  --client-config=.secrets/php-fcm/google-services.json
```

エックスサーバーのPHP 8.4.27から、実際のOAuth認証と募集通知形式の`validate_only`に成功しました（`validated: true`、`sent: false`）。鍵はSSHの標準入力で渡し、試験コードは公開領域外の一時ディレクトリーから撤去しました。端末への送信・表示、継続的なcron運用は未検証です。

## 1分程度の通知と負荷

Androidの更新間隔は既定60秒・下限60秒、板一覧は既定300秒を維持します。投稿から次の監視まで通常0〜60秒程度で、取得・判定・ntfy・端末の処理時間が加わります。通信・電池制限・停止を含め「必ず60秒以内」の配送は保証しません。

同じdatを60秒ごとに取得すると30日で43,200回、板一覧の300秒更新は8,640回です。同じ板・スレッドは購読者間で共有取得します。平均200KiBのdatを毎回全取得した場合、圧縮・差分を考慮しない概算で1スレッド当たり約8.2GiB/月です。これにntfyの接続維持・配送・再接続も加えて実測します。

登録人数の固定上限を設けない方針と、一定料金で無限の接続・判定・配信を処理できることは別です。処理の遅れ、送信待ち、同時接続、メモリ、転送量を測り、最適化・増強を判断します。VPSの契約・配備は今回行っていません。
