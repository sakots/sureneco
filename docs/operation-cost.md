# 通知サーバーの運用費比較

## 前提と現時点の結論

2026/10/22時点の検討です。契約済みなのはエックスサーバーの通常の共用レンタルサーバーで、その既存料金は比較から除外します。通知の遅れは1分程度を目標にします。アプリはAndroid、配送はFirebase Cloud Messaging（FCM）、匿名認証とApp Checkは維持します。

追加月額0円を最初に目指すなら、**既存エックスサーバーのHTTPS/PHP・永続保存・毎分cronを使い、監視処理を1回実行して終了する構成**を先に検証します。Node.js 24の単発実行が利用できれば、判定用TypeScriptをそのまま実行でき、VPSとサーバー用Rustビルドを省ける可能性があります。これは設計上の候補であり、契約環境で動作確認した結果ではありません。

VPS版の実装はいったん中断しています。[進捗記録](server-progress.md)と[VPS案の資料](node-vps.md)は再開用に保持します。費用比較だけでサーバー構成を自動変更したり、契約や配備を行ったりはしません。

Node.js＋VPSで登録人数の上限を設けずに公開する場合の価格・制約・増強判断は[専用の比較資料](vps-cost.md)を参照してください。

## 候補の比較

| 案 | 追加料金の目安 | 1分程度の監視 | 実装・運用上の判断 |
| --- | --- | --- | --- |
| 既存エックスサーバー＋毎分単発処理＋FCM | 既存契約とFirebaseの無料範囲内なら0円 | cronの毎分設定と処理時間を実環境で確認 | 第一検証候補。Node.js・外部実行・負荷の許容範囲を確認。APIとバッチの分担を再設計する |
| OCI Always Free＋現在のNode.js案 | 対象リソースの無料枠内なら0円 | 常駐監視を構成できる | 空き容量・アカウント条件・アイドル回収がある。取得や継続稼働を保証できず、VPS管理も必要 |
| Cloudflare Workers Free＋Cron・永続DB | 各無料枠内なら0円 | 毎分スケジュールの構成を検討できる | 通常の常駐Node.jsとは異なる。DB・ワーカー隔離・SDK周辺の移植とCPU上限の実測が必要 |
| 有料VPS＋現在のNode.js案 | VPSの月額が追加 | 常駐監視を構成できる | 既存の試作を使いやすいが、今回の追加0円という目標より後順位 |
| GitHub Actionsの定期実行 | リポジトリー・利用枠による | 不適合 | 公式の最短間隔は5分。遅延や実行欠落もあり、今回の目標には使わない |

OCIはAlways Free対象のリソースでも空き容量不足やアイドル回収があるため、安定した通知を無料で保証する根拠にはできません。[OCI公式の無料枠と制限](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)を参照してください。

Workers Freeは1日100,000リクエスト・通常のCPU時間10ms等の制約があります。毎分の起動回数だけなら小さくても、datの解析と利用者ごとの正規表現実行がCPU予算に収まるかは別問題です。現行の`node:sqlite`とNode.jsワーカーをそのまま配置する案にはしません。[Workersの料金](https://developers.cloudflare.com/workers/platform/pricing/)と[実行制限](https://developers.cloudflare.com/workers/platform/limits/)を参照してください。

GitHub Actionsの[実行間隔](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule)と[定期実行の遅延・欠落](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)は、1分程度という前提を満たしません。

有料VPSの比較用として、XServer VPSの2GB通常料金は1ヶ月契約で月額1,980円、36ヶ月契約は月額換算1,265円です。後者は長期契約の単価で、1ヶ月だけ使う価格ではありません。キャンペーン・契約期間・更新価格を分けて確認します。[2026/9/1の公式料金改定](https://vps.xserver.ne.jp/support/news_detail.php?view_id=19107)に基づく例であり、有料VPS全体の最安値とはしていません。

## エックスサーバーで確認できたこと・未確認のこと

公式の[cronマニュアル](https://www.xserver.ne.jp/manual/man_program_cron.php)は、指定時刻のコマンド実行を提供しています。`* * * * *`相当の毎分設定を候補にします。ただし、[cronのFAQ](https://www.xserver.ne.jp/support/faq/service_server_cron.php)では高負荷時に利用を制限する場合があるとしています。毎分起動できることと、任意の負荷を許されることは別です。

[標準の言語・コマンド一覧](https://www.xserver.ne.jp/manual/man_program_soft.php)ではPHPを確認できますが、Node.js 24の保証は確認できませんでした。[外部プログラムのFAQ](https://www.xserver.ne.jp/support/faq/service_server_program_introduction.php)では未確認ソフトは利用環境での確認が必要で、root権限を必要とする導入はできないとしています。Node.jsが確実に動く、常駐が許可される、systemdやNginxを自由に設定できるとは判断しません。

[SSH機能](https://www.xserver.ne.jp/manual/man_server_ssh.php)で、次の環境情報を確認するところから始めます。以下は確認用で、Node.jsのインストールやサーバー設定の変更を行うものではありません。

```sh
command -v node
node --version
command -v php
php --version
php -m
uname -m
getconf GNU_LIBC_VERSION
```

Node.jsが利用できた場合は、現在のTypeScriptの実行と`node:sqlite`・ワーカーが使えるバージョンかを確認します。Node.jsが見つからなくても、直ちにroot権限でインストールしようとはしません。ユーザー領域の実行が許容されるか、契約サーバーのOS・ライブラリーに合うかを確認します。

必要な確認項目は以下です。

- 毎分cronを設定でき、実際に開始・完了時刻が更新されること。
- PHPのcURL・OpenSSL・PDO SQLite、必要なら`proc_open`での単発ワーカー起動が利用できること。WebとCLIの設定差も確認。
- Node.jsを使う場合は24以上の単発実行、必要なワーカーとSQLiteが利用できること。実行可否と提供元の許容条件を両方確認。
- サーバーから5chの板・dat、Googleの認証鍵・FCMへHTTPS接続できること。外部サイト側の接続制限は別途確認。
- 秘密鍵・購読設定・DB・ロックを公開領域外へ置き、APIとcronから共有できること。
- 対象スレッド数と購読数を想定した処理が毎分の起動周期に収まり、重複実行の排他と障害復旧が機能すること。

契約アカウントへの接続・設定確認はまだ行っていません。公式マニュアルにある機能と、実際の契約環境での成功を混同しないでください。

## 追加0円案での役割分担

```text
Android → 契約済みのHTTPS/PHP API → 購読設定・SQLite
                                   ↑
毎分cron → 期限を迎えた購読を取得 → 共通TypeScriptの判定 → FCM → Android
          1回処理して終了
```

WebのAPIは共用サーバーのPHPを利用する案とし、募集判定をすべてPHPへ書き換えることは前提にしません。Node.jsの単発実行を確認できれば、既存TypeScriptを隔離して判定する構成を検討します。Node.jsが使えない場合は、以前のビルド済み判定ワーカーを利用できるかを確認します。どちらも使えなければ、共用サーバー案を採用できるとは判断しません。

PHP版のAPI等はGit履歴にありますが、現在のNode.js版のSQLite設計やプロセス構成へ自動で接続できる状態ではありません。APIの認証・設定検証と単発処理の分担、DBの同時利用、送信資格情報、終了条件の設計が必要です。常駐Node.js版をそのままcronに登録すると終了せず重複起動するため、登録しないでください。

FCMの生トークンを認証代わりにしたり、App Check・NG・許可ワッチョイ・締め・期限・重複防止を省略したりして料金を下げる案にはしません。これらは既存の振る舞いを維持します。

## Firebase側の追加料金

FCM自体は無料です。匿名認証とApp Checkは無料範囲・プロバイダーの利用上限を確認して使います。電話番号認証、Firestore、Cloud Functions、Cloud Scheduler、Cloud Run等の追加は、この0円案には含めません。[Firebase公式料金](https://firebase.google.com/pricing)と[プランの説明](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)に基づきます。利用規模やプロジェクト設定に関係なく、Firebase全体が無制限に無料という意味ではありません。

管理者用Webページとプライバシーポリシー等は既存のホームページスペースを使い、その既存料金を重ねて計上しません。新しい独自ドメインも必須にしません。

## 遅延と負荷の考え方

毎分実行なら投稿から次の実行までは通常0〜60秒程度ですが、取得・判定・FCMとOS側の配送時間がさらに加わります。1分程度を目標にできても、「必ず60秒以内」の保証にはなりません。送信前に締め・期限を確認し、重い処理は次回へ残し、終了しない待機ループを入れません。

30日間、同じスレッドのdatを60秒ごとに1回取得すると43,200回です。板一覧の300秒更新は8,640回です。同じ板・スレッドは購読者間で共有し、端末数だけ同じ取得を増やさないことが負荷と費用の抑制になります。例えば平均200KiBのdatを毎回全取得すると、圧縮・差分を考慮しない概算で1スレッド当たり約8.2GiB/月です。実際のサイズ・取得方法・転送量を測ってから対象数を増やします。

最初は既存エックスサーバーで、毎分単発処理の可否・実行時間・外部通信・共有取得の負荷を確認します。条件を満たせば追加0円案を優先し、満たせない場合に無料VMや有料VPSを比較し直します。現時点では新規VPS契約は不要です。
