# Android版の開発と配布準備

現在は実装中です。Android版のAAB生成、Firebaseからの実配信、Google Play公開はまだ確認していません。進捗は[作業項目](../openspec/changes/android-google-play/tasks.md)に記録します。

## 構成

Node.jsの常駐サーバーが5chの板・監視スレッドを取得し、既存の募集判定・NG・許可ワッチョイを端末ごとに適用します。SQLiteへ監視条件、取得済みレス番号、通知イベントと送信待ちを保存し、Firebase Cloud Messaging（FCM）でAndroidへ配信します。

Androidは別アプリの利用中・画面消灯中もプッシュを受け取ります。端末内で20秒ごとに常駐取得する方式ではありません。表示中の一覧取得とOS通知を分離し、通知はプッシュへ統一します。圏外、通知拒否、Android設定での強制停止、FCMの配送遅延等では受信できない場合があります。

PC版のトレイ、実行ファイル指定、設定フォルダー変更、ウィンドウ状態の保存、GitHub経由の更新はAndroidに持ち込みません。Androidのアプリ更新はGoogle Playから行います。

## 必要な環境

- Node.js、pnpm、Rust。バージョンと既存のチェック手順は[開発手順](development.md)を参照。
- Java 21、Android SDK Command-line Tools、Platform Tools、API 36以上、NDK、ARM64用Rustターゲット。
- 実機またはエミュレーター。ネイティブ依存を含む16KBページサイズの動作も確認。
- Google Playのアプリ登録と、Android用アップロード署名鍵。PC版の更新署名鍵は使いません。
- 常時Node.jsを動かせるサーバー、SQLiteの永続保存領域、HTTPSのAPI公開先。
- Firebaseプロジェクト。Androidアプリ登録、Cloud Messaging、匿名認証、App Check（公開時はPlay Integrity）を設定。

現在用意されているのはAndroid端末です。Firebaseプロジェクトと運用先は未設定です。ローカル検証と実際のFirebase接続を必要とする確認は分けて記録します。

## 認証・保存と停止

通知の利用開始前に、サーバーへ保存する情報と削除方法を説明して同意を受けます。Firebase匿名認証で端末を識別し、監視スレッド、板URL、更新周期、検出条件、NG・許可ワッチョイ、有効期間、FCM通知先と設定リビジョンを同期します。PC用の実行ファイルパスや設定フォルダーは送信しません。

監視停止時は端末で即時に通知を抑止し、サーバーでも購読と送信待ちを止めます。登録削除ではその端末の通知先、監視設定、配信履歴を削除します。圏外ではサーバー反映待ちと表示し、通信回復後に再送します。

秘密鍵、認証トークン、FCMトークン、NG全文を通常ログへ出しません。サーバー資格情報はAndroid配布物へ含めません。

## 検証と公開の区別

ローカルテスト、Androidクロスビルド、署名付きAAB、実際のFCM受信、Play内部テスト、正式公開はそれぞれ別に確認します。モックで成功した認証・配送を、Firebaseへの実接続が成功したものとして扱いません。

契約、課金、Firebaseの新規作成、サーバーへのデプロイ、Play/GitHubでの公開はビルド処理から行いません。公開先・権限・費用負担を確認してから進めます。

## 仕様

[Android版の提案](../openspec/changes/android-google-play/proposal.md)、[設計](../openspec/changes/android-google-play/design.md)、[作業項目](../openspec/changes/android-google-play/tasks.md)を参照してください。
