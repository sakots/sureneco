# 通知サーバーの実装進捗と中断時の記録

利用者の指示により、2026/10/22に実装を一旦中断しました。次の判断材料は、契約済みエックスサーバーを利用した追加費用の最小化と、1分程度の通知です。Node.js＋VPSで登録人数の上限を設けない案も[費用と負荷](vps-cost.md)を比較します。[運用費の比較](operation-cost.md)を先に確認してください。

## 試作した範囲

作業ブランチは`feat/node-vps-server`です。VPS向けNode.js版として、以下のコードを作成しました。最終チェックと実環境検証が終わっていないため、完成・配備済みとは扱いません。

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

1. 最終ソースでのビルド、全テスト、書式、テーマ、差分チェック。`--check-config`を含む起動経路の最終確認。
2. API・監視・配送・排他・停止処理の最終レビュー。systemd・Nginx設定例と環境ファイルの実機確認。
3. 実際のFirebase認証、App CheckとFCM配送、Androidの認証・設定同期・受信処理。
4. VPSを採用するか、エックスサーバー上の毎分単発処理へ変更するかの判断。共用サーバー案のNode.js・PHP・cron・負荷と外部通信は未確認。
5. 採用する構成に合わせたOpenSpecの提案・設計・仕様差分・タスクの更新。現在のチェックボックスは試作だけで完了へ進めていません。

`monitoringReady: false`を維持します。VPS・Firebase等への接続、契約・課金、デプロイ、公開は行っていません。次回は運用方式を決めてから実装を再開し、この試作の存在を理由にVPSを必須にしないでください。
