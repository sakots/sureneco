# 通知サーバーの運用方針と費用

2026/10/22に、**Node.js＋VPSの監視、UnifiedPush＋自前ntfyの通知**を採用しました。Firebaseは使いません。利用者の依頼により実装を再開しています。[採用構成](unifiedpush-ntfy.md)と[進捗](server-progress.md)を参照してください。

2026/10/27の利用者方針は、VPS不要のPHP案を将来候補として記録し、当面は既存のNode.js版を優先して進めることです。PHP版の実装・配備や、既存Node.js版からの切り替えは行いません。

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

## 1分程度の通知と負荷

Androidの更新間隔は既定60秒・下限60秒、板一覧は既定300秒を維持します。投稿から次の監視まで通常0〜60秒程度で、取得・判定・ntfy・端末の処理時間が加わります。通信・電池制限・停止を含め「必ず60秒以内」の配送は保証しません。

同じdatを60秒ごとに取得すると30日で43,200回、板一覧の300秒更新は8,640回です。同じ板・スレッドは購読者間で共有取得します。平均200KiBのdatを毎回全取得した場合、圧縮・差分を考慮しない概算で1スレッド当たり約8.2GiB/月です。これにntfyの接続維持・配送・再接続も加えて実測します。

登録人数の固定上限を設けない方針と、一定料金で無限の接続・判定・配信を処理できることは別です。処理の遅れ、送信待ち、同時接続、メモリ、転送量を測り、最適化・増強を判断します。VPSの契約・配備は今回行っていません。
