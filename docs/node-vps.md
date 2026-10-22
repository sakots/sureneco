# Node.js＋VPSのサーバー構成

[README](../README.md) / [Firebaseの設定](firebase-setup.md) / [Android開発](android.md)

Android向け通知サーバーは、VPS上でNode.jsを常駐させる方針に変更しました。PHP＋毎分cronの構成を置き換えます。この資料は実装前の構成と準備事項です。現状の`server/`はPHP版で、Node.js用のビルド・起動コマンドはまだありません。

## 構成

```text
Androidアプリ
  └─ HTTPS → Nginx → Node.jsの購読API（127.0.0.1）
                         ├─ Firebase匿名認証・App Checkの検証
                         ├─ SQLite（設定・取得基準・送信待ち）
                         └─ 常駐スケジューラー
                              ├─ 5chの板・dat取得
                              ├─ 分離ワーカーで既存TypeScriptコアの判定
                              └─ Firebase Admin SDK → FCM → Androidへ通知

systemd：Node.jsサービスの起動・停止・異常終了後の再起動
```

APIと監視処理は単一サービスで管理します。毎分cronは使わず、スケジューラーが購読の更新周期と配送の再試行時刻を確認します。DBを共有する二重起動と、監視回の重複実行を防ぎます。

Node.jsは24 LTSを採用し、実装時に動作確認したパッチ版を固定します。DBはSQLite、接続には組み込みの`node:sqlite`を使用する設計です。認証とFCMにはFirebase Admin SDKを使います。[Node.jsのリリース情報](https://nodejs.org/en/about/previous-releases)と[Firebase Admin SDKの公式資料](https://firebase.google.com/docs/admin/setup)を参照してください。

ユーザー定義の正規表現はAPIのメインスレッドで実行せず、時間・メモリ・入出力の上限を設けたワーカーで判定します。PC・Androidで利用するRust/QuickJSは維持しますが、PHP向けのサーバー用QuickJS実行ファイルは移植後に撤去します。

## VPSで準備するもの

| 項目 | 内容 |
| --- | --- |
| OSと接続 | Ubuntu等のLinux、SSH、管理権限、systemd |
| 実行環境 | Node.js 24 LTS。pnpmとビルド環境は開発・更新時に使用 |
| 公開先 | API用のドメイン、DNS、HTTPS証明書、Nginx等のリバースプロキシ |
| 通信 | Google・5chへの外向きHTTPS、CA証明書、正しいサーバー時刻 |
| 保存先 | 再起動後も残るSQLite、公開領域外の秘密鍵、バックアップ |
| Firebase | プロジェクト、Android登録、匿名認証、App Check、FCM送信権限 |
| 運用 | 専用実行ユーザー、サービス再起動、障害検知、費用負担と担当者 |

VPSのプランは、利用人数と監視対象数に応じて決めます。契約・課金・DNS変更・デプロイはこの計画更新では実行しません。

Firebaseは既に作成したプロジェクトを利用できます。Androidの登録パッケージ名は`sureneco.sakots`です。`google-services.json`はAndroid側の`src-tauri/gen/android/app/`に置き、サーバーにはFCM送信用サービスアカウントJSONを別に配置します。

## 実装後のセットアップ順序

以下はNode.js版の完成後に検証する順序です。現時点で実行可能な新サーバーの導入手順ではありません。

1. VPSに専用ユーザーとコード・SQLite・資格情報の保存領域を用意する。コードと秘密鍵はHTTPSで配信するディレクトリーに置かない。
2. Node.js版の同じリビジョンから依存を導入・ビルドし、API・監視・配送の回帰テストを通す。
3. FirebaseプロジェクトIDと許可するAndroidアプリID、送信資格情報のパス、DBの絶対パス、ローカル待受を設定する。確定した環境変数名は実装と一緒にこの資料へ反映する。
4. Node.jsを専用ユーザーで起動し、状態APIと購読API、停止・削除を確認する。資格情報やトークンをログへ出さない。
5. NginxからローカルのNode.jsへHTTPS要求を転送し、Firebase IDトークンとApp Checkのヘッダーが維持されることを確認する。Node.jsのポートを直接インターネットへ公開しない。
6. systemdへ登録し、異常終了後の再起動、SIGTERMでの停止、DBの二重起動拒否と再起動後の状態復元を確認する。
7. 最後の監視完了時刻、取得・配送エラー、送信待ちの滞留、DB容量を監視し、バックアップと削除の扱いを確認する。
8. Android側の認証・受信実装後に、実際のFCM配送、別アプリ利用・画面消灯中の受信、停止後の抑止を検証する。

公開の前提は、APIのHTTP応答だけでなく監視と実配送が確認できることです。Node.js移植前のPHPのローカル検証結果は、Node.js版の動作確認とは分けます。

## 更新周期と保存する情報

Androidのサーバー側`update_sec`は既定60秒、`thread_update_sec`は既定300秒で、下限はどちらも60秒を維持します。常駐化後は期限を迎えた購読を処理し、70秒設定を毎分cronの120秒回まで待たせません。負荷・通信・FCMによる遅延はあり、即時通知を保証する値ではありません。PC版の20秒設定には影響しません。

SQLiteにはUID、通知先、同意と設定、監視対象、リビジョン、取得基準と状態、通知イベント、送信待ちを保存します。初回取得では過去募集を通知せず、再起動後も基準とイベントIDを復元します。停止時は送信待ちを破棄し、登録削除では本人の情報を削除します。自動データ移行とPHPとの二重運用は追加しません。

## 実装の進め方

[作業項目](../openspec/changes/android-google-play/tasks.md)に従い、起動・保存・停止、認証と購読API、共有取得と分離判定、FCMと永続再試行の順に移植します。各段階で必要なテストを先に書き、Node.js版で回帰確認した後に対応する旧PHPコード・テスト・ビルド設定を撤去します。

現行PHPコードの配置を調べる場合のみ、[置換予定のPHP手順](php-setup.md)を参照してください。新しいVPSの構成としてPHPをセットアップする必要はありません。
