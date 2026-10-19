# AGENTS.md

## プロジェクト概要

surenecoは、5ch麻雀板のじゃんたまスレッドにおける友人戦募集を通知する常駐型アプリです。
windowsとLinux（Ubuntu）に対応します。

## コーディング

Tauri 2 + Rust + TypeScript / Reactで実装します。Reactはtsxを使ってコードを書いてください。
Reactではpnpmを使用します。

## アプリの仕様

[5ch麻雀板](https://egg.5ch.io/mj/)（スレッド一覧は[こちら](https://egg.5ch.io/mj/subback.html)）から[「雀魂 - じゃんたま -」](https://mahjongsoul.com/)関連のスレッドを探し、一覧に出す。
友人戦募集を通知してほしいスレッドはトグルスイッチをオンにして通知を受け取る。
じゃんたまのスレッドであることは、正規表現等で定義する。ユーザー設定もできるようにする。
友人戦募集も正規表現等で定義し、ユーザー設定もできるようにする。
募集レス中の文字列、ID、ワッチョイなどで通知しないNG設定をできるようにする。

## 設定項目

- `update_sec` 友人戦募集の更新頻度(秒)。20以上の整数。既定20秒。
- `thread_update_sec` スレッド一覧の更新頻度(秒)。20以上の整数。既定300秒。
- `elapsed_days` スレッド候補に表⽰されるスレッドの、スレ建てからの経過⽇数。
- `emphasis_sec` 新規友⼈戦募集とみなす期間(秒)
- `thread_title_regex` ⿇雀板から雀魂スレッドを検索するための正規表現
- `ng_thread_title_regex` thread_title_regexで検出した雀魂スレッドに対して、除外したいスレッドがある場合に使⽤する正規表現
- `yujinsen_regex` 友⼈戦募集レスを検出するための正規表現
- `closed_yujinsen_regex` 友⼈戦の締めレスを検出するための正規表現
- `url` 5chのURL

## 開発のサイクル

開発は以下のサイクルで行うこと。

1. 資料を更新する。常に開発は資料ファーストで先に資料を更新して矛盾や古い情報が無いことを確認する。
2. テストを書く。TDDで進める。
3. 最小実装する。
4. 不要コード、資料矛盾がないか最終確認する。

また、以下に注意して下さい。

- 後方互換やデータ移行コードを不必要に書かないこと
- 不要になったコードやドキュメントは消すこと
- 不必要にテストやコードを書き込まないようにすること

## コミット

- 変更や修正1つにつき1回コミットを行う。mainブランチで作業しないこと。
- コミットのフォーマットは、`<Type>: <Emoji> #<Issue Number> <Title>`。
- `<Type>`のプレフィックスは以下である。

```text
feat: 新しい機能
fix: バグの修正
docs: ドキュメントのみの変更
style: 空白、フォーマット、セミコロン追加など
refactor: 仕様に影響がないコード改善(リファクタ)
perf: パフォーマンス向上関連
test: テスト関連
chore: ビルド、補助ツール、ライブラリ関連
```

- `<Emoji>`はカラフルにするためにつける。[gitmoji](https://gitmoji.dev/)から選ぶと良い。
- `#<Issue Number>`はGithubにあるissueに関連する場合つける。
- `<Title>`がコミットの内容である。必ずコミットの理由を書くこと。（例：〇〇なため、△△を追加）

## リリース

- 「リリースして」と依頼があった場合にのみ、Githubのreleaseページに公開する。
- 対象ブランチはmain。タグは、`vx.x.x`。
- 公開形式は正式公開とする。
- Windows実機確認は必須としない。
- リリースノートの元資料は`changelog.md`の該当バージョンとする。
- 同名タグ・添付ファイルがあれば上書きせず停止する。
- リリース前にテスト・差分チェックを通す。

### リリースノートの形式

```txt
## vx.x.x

- (changelog.mdから更新履歴を記入する)
- (箇条書きで変更点を記入する)

## ダウンロード

### windows

- [sureneco_v0.x.x_Setup.exe](https://github.com/sakots/sureneco/releases/download/vx.x.x/sureneco_v0.x.x_Setup.exe) インストーラー
- [sureneco_v0.x.x_win.zip](https://github.com/sakots/sureneco/releases/download/vx.x.x/sureneco_v0.x.x_win.zip) ポータブル版

### Linux

- [sureneco_v0.x.x.amd64.deb](https://github.com/sakots/sureneco/releases/download/vx.x.x/sureneco_v0.x.x.amd64.deb)  deb
- [sureneco_v0.x.x.AppImage](https://github.com/sakots/sureneco/releases/download/v0.x.x/sureneco_v0.x.x.AppImage) AppImage
```

## 作業上の注意

- 作業ツリーにあるユーザーの未コミット変更を消したり、無関係な形式変更をしない。
- `README.md`、`changelog.md`に、更新履歴の追加を行う。

## 更新履歴加筆の際の注意

- 更新履歴の形式は、`### [YYYY/MM/DD] vx.x.x`のあとに箇条書き。
- ～～を修正、～～の機能を追加、～～を～～～するようにした、のような形式で書くこと。
