# sureneco

![Last commit](https://img.shields.io/github/last-commit/sakots/sureneco)
![version](https://img.shields.io/github/v/release/sakots/sureneco)
![Downloads](https://img.shields.io/github/downloads/sakots/sureneco/total)
![License](https://img.shields.io/github/license/sakots/sureneco)

5ch麻雀板の雀魂スレッドから友人戦募集を通知する、Windows / Ubuntu向け常駐アプリです。ウィンドウを閉じてもトレイで監視を続けます。

![アプリ画面](images/app.png)

## ダウンロード

[GitHub Releases](https://github.com/sakots/sureneco/releases/latest)からダウンロードできます。

- Windows：インストーラー（`Setup.exe`）またはポータブル版（`win.zip`）
- Ubuntu：DEB（`amd64.deb`）またはAppImage

WindowsではWebView2が必要です。インストーラーは必要に応じて導入します。Electron版から切り替える場合は[移行手順](docs/usage.md#electron版からの切り替え)を確認してください。

## 使い方

1. 通知を受けたいスレッドのトグルをオンにします。
2. 友人戦募集が見つかると通知します。検出用正規表現やNG条件は設定で変更できます。
3. 募集のルームIDをクリックしてコピーするか、「雀魂を起動」でコピーしてゲームを開きます。

ウィンドウを閉じるとトレイに常駐し、トレイメニューから終了できます。Ubuntuではトレイに対応したデスクトップ環境が必要です。トレイを作成できない環境ではウィンドウを閉じると終了します。

設定の保存先、通知条件、アプリの更新、ブラウザー・Steamの指定などは[使い方](docs/usage.md)を参照してください。

## 資料

- [使い方](docs/usage.md)：監視・通知、設定フォルダ、雀魂の起動、更新、Electron版からの切り替え
- [開発](docs/development.md)：構成、環境構築、起動とチェック
- [配布物の作成](docs/packaging.md)：Windows / Linuxビルド、署名、SSH先でのビルドと取得
- [仕様と変更管理](docs/specification.md)：機能別仕様、OpenSpecの手順、検証
- [Tauri移行時の構成](docs/tauri-migration.md)：技術選択と移行時の記録

## 更新履歴

### [2026/10/19] v0.8.3

- Ubuntuのアプリセンターでパッケージの説明が文字化けし、`(none)`が表示される問題を修正
- READMEの詳細手順を用途別の資料へ移し、過去の更新履歴をchangelog.mdに集約

過去の更新履歴は[changelog.md](changelog.md)を参照してください。
