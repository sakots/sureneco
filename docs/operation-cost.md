# 通知サーバーの運用方針と費用

2026/10/22に、**Node.js＋VPSの監視、UnifiedPush＋自前ntfyの通知**を採用しました。Firebaseは使いません。利用者の依頼により実装を再開しています。[採用構成](unifiedpush-ntfy.md)と[進捗](server-progress.md)を参照してください。

## 費用を抑える構成

Node.js・SQLite・ntfy・HTTPSプロキシを同じ小規模VPSにまとめます。契約済みのエックスサーバーは案内・ダウンロードリンク・プライバシーポリシーの掲載に使い、既存料金は追加費用に含めません。現時点では外部DB・Redis・複数VPSを契約しません。

追加費用の中心はVPSと必要なバックアップ・転送等です。Firebaseの利用料は見込みません。利用者にはAndroidのntfyアプリを別途導入してもらい、自前サーバーへ接続する構成です。料金例と増強判断は[人数制限を設けないVPS運用](vps-cost.md)を参照してください。

## 比較した案と採用範囲

| 案 | 判断 |
| --- | --- |
| 既存エックスサーバー＋毎分単発処理 | FCMを使う費用比較では追加0円の候補だった。今回はntfyの常駐接続も必要なため採用しない |
| 小規模有料VPS＋Node.js＋自前ntfy | 採用。まず1台で共有取得・判定・配信と接続維持を測る。契約先・容量は未決定 |
| OCI Always Free | 無料対象リソースでも空き容量・アイドル回収等の条件があり、安定稼働を保証できない。現時点で採用先に指定しない |
| Cloudflare Workers Free | 現行の常駐Node.js、node:sqlite、分離ワーカーをそのまま動かす構成ではなく、ntfyの配置先も別途必要 |
| GitHub Actions定期実行 | 最短5分のため、1分程度の監視目標には使わない |

参考：[エックスサーバーの外部プログラム制約](https://www.xserver.ne.jp/support/faq/service_server_program_introduction.php)、[OCI無料枠](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)、[Workers制限](https://developers.cloudflare.com/workers/platform/limits/)、[GitHub Actions実行間隔](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule)。共用サーバーで常駐Node.js・ntfyを運用できると確認したものではありません。

## 1分程度の通知と負荷

Androidの更新間隔は既定60秒・下限60秒、板一覧は既定300秒を維持します。投稿から次の監視まで通常0〜60秒程度で、取得・判定・ntfy・端末の処理時間が加わります。通信・電池制限・停止を含め「必ず60秒以内」の配送は保証しません。

同じdatを60秒ごとに取得すると30日で43,200回、板一覧の300秒更新は8,640回です。同じ板・スレッドは購読者間で共有取得します。平均200KiBのdatを毎回全取得した場合、圧縮・差分を考慮しない概算で1スレッド当たり約8.2GiB/月です。これにntfyの接続維持・配送・再接続も加えて実測します。

登録人数の固定上限を設けない方針と、一定料金で無限の接続・判定・配信を処理できることは別です。処理の遅れ、送信待ち、同時接続、メモリ、転送量を測り、最適化・増強を判断します。VPSの契約・配備は今回行っていません。
