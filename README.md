# sureneco

5ch麻雀板の雀魂スレッドから友人戦募集を通知する、Windows / Ubuntu向け常駐アプリです。Electron + TypeScript + Reactで実装しています。

## 開発

Node.js 22.12以上とpnpmを用意してください。

```sh
pnpm install
pnpm exec install-electron
pnpm dev
```

`pnpm exec install-electron`はElectron本体を取得します。`pnpm dev`でViteとElectronを起動します。メインプロセスとpreloadを変更したときは開発コマンドを再起動してください。`pnpm check`でテスト、型チェック、ビルド、テーマ診断を実行します。

```sh
pnpm build
pnpm start
pnpm package:linux   # Ubuntu: AppImage / deb
pnpm package:win     # Windows: NSISインストーラー（Windows上で実行推奨）
```

パッケージはrelease/に出力します。

## 使い方

スレッド一覧のトグルをオンにすると監視します。初回は既存レスを基準にし、次の更新から新しい募集を通知します。設定で更新間隔、検出用正規表現、NG本文・ID・ワッチョイを変更できます。NGは一行一件で入力します。募集をクリックするとブラウザーで該当レスを開きます。

ウィンドウを閉じるとトレイに常駐します。終了はトレイメニューから選択してください。Ubuntuではトレイを表示できるデスクトップ環境が必要です。トレイを作成できない場合はウィンドウを閉じると終了します。OSの通知設定によって通知が表示されない場合があります。

設定と取得済みレス番号はElectronのuserDataディレクトリに保存します。通信失敗は画面に表示され、次回更新で再試行します。5ch側のアクセス制限や形式変更で取得できない場合があります。

詳細は[仕様書](docs/specification.md)を参照してください。

## 更新履歴

### [2026/10/04] v0.1.0

- スレッド選択、募集通知、締め検出、NG設定、トレイ常駐を実装。
- Windows / Ubuntu向けビルド設定と検証コマンドを追加。

### [2026/10/04] v0.0.0

- リポジトリを作成。
