# 通知サーバーの実装進捗と中断時の記録

利用者の指示により、2026/10/22に実装を一旦中断しました。その後、Node.js＋VPSの監視とUnifiedPush＋自前ntfyによる通知を採用しました。今回は設計・仕様・運用資料だけを更新し、実装再開・契約・配備は行っていません。[採用構成](unifiedpush-ntfy.md)と[費用](vps-cost.md)を参照してください。

## 試作した範囲

作業ブランチは`feat/node-vps-server`です。VPS向けNode.js版として、以下のコードを作成しました。Firebase版の試作であり、採用したUnifiedPush版にはまだ置き換わっていません。最終チェックと実環境検証が終わっていないため、完成・配備済みとは扱いません。

- `server/store.ts`：SQLite、トランザクション、所有権用SQLite接続による二重起動の排他。
- `server/api.ts`・`subscriptions.ts`：購読登録・更新・照会・停止・削除、UID別の所有者制限、入力と頻度の上限。
- `server/monitor.ts`・`scheduler.ts`：常駐監視、板・datの共有取得、初回・再開の通知基準、永続カーソル、イベントと送信待ちの同時保存。
- `server/worker.ts`・`detection*.ts`：既存TypeScriptコアの募集判定、JavaScript正規表現の分離実行、時間・メモリ・入出力の上限。
- `server/firebase*.ts`・`delivery.ts`：Firebase Admin SDKの認証・App Check・FCM接続、配送前のリビジョン・期限確認、最大5回の永続再試行。SDKも別ワーカーで実行。
- `server/main.ts`、`scripts/build-server.mjs`：起動・終了とビルド。`package.json`に`build:server`・`server:start`・`test:server`を追加。
- `server/server.env.example`・`sureneco.service`・`nginx.conf.example`：VPS向けの設定例。運用先で未検証。

作業ツリーではPHPコード・専用テスト・サーバー用Rustワーカー・PHP導入資料を削除しました。旧実装はこのブランチの親コミットまでのGit履歴にあります。PC・Android本体のRust/QuickJSは変更していません。生成済みの旧Rustワーカー出力はGit除外のまま保持します。PHP版からの自動DB移行はありません。

## 確認済みの範囲

Node.js 24.22.1と26系でNode.jsサーバーのローカル回帰テストを実行しました。26件の成功を確認した後、null・改行を含む入力の検証を修正し、その対象テスト1件を再確認しました。最終変更後の全体一括テストは未実施です。

確認した経路は、HTTPの登録・照会・停止・削除、別UIDと通知先競合、入力とレート制限、共有取得と70秒設定、初回基準、NG・許可ワッチョイ・参照・締め・期限、200件超の送信待ち、DB保存失敗時の回復、再試行と無効通知先、送信成功後の保存失敗、重い正規表現の強制終了、強制終了後のサービス再起動です。TypeScriptの型チェックも通っています。

Firebase SDKへの不正な形式のトークン入力は拒否を確認しましたが、実際のFirebaseで署名済みのID・App Checkトークンを取得して認証成功を確認したものではありません。FCMのペイロード・TTLと配送状態のテストも、実配送の成功ではありません。

## 残っていること

1. Firebase認証・App Checkを自前の端末別認証へ、FCMをUnifiedPush／Web Pushへ置き換える。Firebase SDK・設定・依存・テストをその変更で撤去する。
2. チャネル所有確認、暗号化・VAPID、通知先更新、ntfyの端末別認証・トピックACL、停止・削除をTDDで実装する。
3. Androidのconnector・中継選択・未導入案内・設定同期・ネイティブ受信を実装し、画面消灯中も実機確認する。
4. Node.jsのビルド・全テスト・書式・テーマ・差分チェック、API・判定・outbox・排他・復旧の最終レビュー。旧`--check-config`と環境例は新方式へ更新して実行確認する。
5. 検証VPSでNode.jsとntfyのsystemd・HTTPS・権限・バックアップを確認し、接続数・メモリ・転送量と通知遅延を測る。価格だけで容量や処理人数を保証しない。

提案・設計・仕様差分・タスクは新方式へ更新済みです。完了チェックは試作だけでは進めず、3/32のままです。`monitoringReady: false`を維持し、旧ローカルテストの成功をUnifiedPush実配信の成功として扱いません。旧PHP版はGit履歴にあり、自動DB移行やFCMフォールバックは追加しない方針です。
