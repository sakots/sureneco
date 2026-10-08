# sureneco

![Last commit](https://img.shields.io/github/last-commit/sakots/sureneco)
![version](https://img.shields.io/github/v/release/sakots/sureneco)
![Downloads](https://img.shields.io/github/downloads/sakots/sureneco/total)
![License](https://img.shields.io/github/license/sakots/sureneco)

5ch麻雀板の雀魂スレッドから友人戦募集を通知する、Windows / Ubuntu向け常駐アプリです。Tauri 2 + Rust + TypeScript + Reactで実装しています。募集検出と監視はRustの専用スレッド上のQuickJSで動かし、ウィンドウを隠しても監視を続けます。Node.js・Electron・Chromiumは配布物に同梱しません。

![アプリ画面](images/app.png)

## 開発

Node.js 22.12以上、pnpm 12.10.1、Rust stableを用意してください。WindowsはMSVC版Rust、Visual Studio C++ Build Tools、WebView2が必要です。Ubuntuは以下をインストールします。

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
pnpm install
pnpm dev
```

`pnpm dev`でViteとTauriを起動します。バックエンドのTypeScriptを変更した場合は開発コマンドを再起動してください。`pnpm check`でTypeScript・Rustのテスト、フロントエンドと監視エンジンのビルド、Rust整形、テーマ診断、差分チェックを行います。初回はRust依存の取得・コンパイルに時間がかかります。

詳しい環境構築は[Tauriの前提条件](https://v2.tauri.app/start/prerequisites/)を参照してください。

## 配布物の作成

Windows版はWindowsまたはUbuntu・WSL2（Ubuntu）、Linux版はUbuntu・WSL2（Ubuntu）で作成できます。WindowsとLinuxのnode_modulesは共有しません。WSLではWSL側のNode.js・pnpm・Rustを使い、プロジェクトをLinux側のホームディレクトリーに置いてください。

```powershell
pnpm package:win
```

```sh
pnpm package:linux
```

Ubuntu・WSLからWindows版も作る場合は、次の準備を一度行います。Windows x64向けにcargo-xwinでクロスコンパイルし、Setup.exeとZIPを生成します。Windows版の動作確認はWindowsで行ってください。

```sh
sudo apt install clang llvm lld nsis cmake ninja-build
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
pnpm package:win
```

WSLでのチェック・ビルドには「開発」に記載したUbuntu用ライブラリーも必要です。Windows版だけを作る場合も、ビルド前にLinux側のRustテストを実行するため必要になります。同じWSL上で`pnpm package:linux`、`pnpm package:win`を実行すると、両方の配布物と更新用のlatest.jsonがrelease/に揃います。クロスコンパイルの構成は[Tauri公式の手順](https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos)に沿っています。

release/へ以下の形式で出力します。配布名とアプリのバージョンはpackage.jsonから反映します。リリース時はsrc-tauri/Cargo.tomlのバージョンも合わせて更新してください。

- `sureneco_v0.6.0_Setup.exe`
- `sureneco_v0.6.0_win.zip`
- `sureneco_v0.6.0.AppImage`
- `sureneco_v0.6.0_amd64.deb`

ZIP版は展開してsureneco.exeを起動します。WindowsではWebView2ランタイムが必要です。インストーラーは必要に応じてWebView2を導入します。

`TAURI_SIGNING_PRIVATE_KEY`は、自動更新用の配布ファイルに署名する秘密鍵の場所（または鍵の内容）を指定する環境変数です。アプリは対応する公開鍵で署名を検証してから更新します。OSやバージョンが変わっても同じ鍵を使います。

この更新用の署名とWindowsのAuthenticode署名は別です。クロスコンパイルでインストーラーの署名をスキップする警告が出ても、更新用の`.sig`は生成します。

署名鍵はこの開発端末の`.secrets/updater.key`に作成済みで、Gitには含めません。鍵を別の安全な場所にも保管してください。別のWindows・WSL環境へcloneしただけでは鍵は付いてこないので、既存の鍵を同じ場所へコピーしてください。この場所なら環境変数の設定は不要です。別の場所に置く場合は`TAURI_SIGNING_PRIVATE_KEY`に鍵のフルパスを設定します。パスワード付きの鍵を使う場合は`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`も設定します。公開鍵はsrc-tauri/tauri.conf.jsonに設定済みです。鍵の内容をGitHubやチャットへ貼り付けないでください。`pnpm dev`には署名鍵は不要です。

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "D:\keys\sureneco-updater.key"
pnpm package:win
```

WSLのBashでは次のように設定します。例ではWindows側のD:\keysに保管した既存の鍵を使います。

```sh
export TAURI_SIGNING_PRIVATE_KEY="/mnt/d/keys/sureneco-updater.key"
pnpm package:win
```

ローカルの配布コマンドはGitHubへ公開しません。WindowsとLinuxの成果物・`.sig`を同じrelease/へ集めて、`pnpm release:manifest`で全形式を含む`latest.json`を生成してください。GitHub Releasesには配布物、`.sig`、この`latest.json`を添付します。Tauri版ではElectron用のlatest.yml・latest-linux.yml・blockmapを使いません。更新時の署名は[Tauri updater](https://v2.tauri.app/plugin/updater/)で検証します。

## Electron版からの切り替え

Tauri版の初回導入は手動で行ってください。Electron版をトレイから終了し、Tauri版を導入します。WindowsのElectronインストール版を削除する場合も設定フォルダーは残してください。Electron版とTauri版を同時起動しないでください。

既存のstate.jsonを同じ場所から読み込み、設定・監視対象・取得済みレス番号を保持します。Windowsは`%APPDATA%/sureneco/state.json`、Ubuntuは`$XDG_CONFIG_HOME/sureneco/state.json`（未指定なら`~/.config/sureneco/state.json`）です。ウィンドウ状態はTauriの別ファイルに保存するため、切り替え直後は既定サイズで開きます。

## 使い方

スレッド一覧のトグルをオンにすると監視します。起動時とトグルをオンにした時点で有効期間内の既存募集も確認・通知し、その後は新しい募集を通知します。更新間隔は既定20秒で、設定から20秒以上の整数に変更できます。スレッド候補は既定でスレ立てから14日以内です。

設定で検出用正規表現、NG本文・ID・ワッチョイを変更できます。NGは一行一件です。「通知を許可するワッチョイ」を指定すると完全一致する投稿者の募集だけを通知します。空欄なら全投稿者が対象で、NGが優先されます。通知許可の設定は募集一覧を絞り込みません。

5桁のルームIDが本文にも参照先にもないレスは募集として扱いません。本文にIDがない場合は過去レスへの`>>レス番号`をたどります。締め切り済み・期限切れの募集への返信は通知せず、返信で期限を延長しません。5桁のIDをクリックすると全角を半角にしてコピーします。「レスを開く」で該当レスをブラウザーから開けます。

通知をクリックするとアプリを再表示し、最小化中なら復元します。終了時のウィンドウサイズ・位置・最大化状態を次回起動時に復元します。Waylandでは位置の取得・復元がOSに制限される場合があります。スレッド・友人戦募集・設定のタブはスクロール中も画面上部に残ります。

ウィンドウを閉じるとトレイに常駐します。終了はトレイメニューから選択してください。トレイを作成できない環境ではウィンドウを閉じると終了します。Ubuntuではトレイを表示できるデスクトップ環境が必要です。OSの通知設定や通知サービスによっては通知が利用できません。通信失敗・通知失敗は画面に表示します。通信は次回更新で再試行します。

設定画面の「アプリの更新」では起動時と6時間ごとにGitHubの正式リリースを確認します。NSIS・AppImage・DEB版は「ダウンロード」→「再起動して更新」で更新できます。DEB版はOSの認証が必要です。Windows ZIP版はリリース画面から手動で更新します。開発実行では更新を無効にします。

## 雀魂の起動

設定の「雀魂の起動」で既定ブラウザー、Chrome / Edgeのプロファイル、指定アプリを選べます。「雀魂を起動」はルームIDをコピーして起動します。ゲーム内の友人戦でIDを貼り付けて入室してください。

Chrome / Edgeは実行ファイルのフルパスと`Default`や`Profile 1`等のプロファイルディレクトリー名を指定します。`chrome://version`または`edge://version`の「プロフィール パス」の末尾で確認できます。通常と異なるユーザーデータフォルダーを使う場合は、その親フォルダーを「ユーザーデータディレクトリー」に指定してください。

指定アプリでは雀魂のexeを指定できます。Steam経由の場合はsteam.exeを指定し、起動引数を`-applaunch`と対象ゲームのApp IDの二行に分けます。引数は一行に一つ、引用符なしで入力します。起動直後の異常終了は実行ファイルのパスと終了コードをエラーに表示します。自動入室には対応していません。

詳細は[仕様書](docs/specification.md)と[移行構成](docs/tauri-migration.md)を参照してください。

## 更新履歴

### [2026/10/09] v0.6.0

- TauriとRustでの実装に切り替え
- Ubuntu・WSLからWindows版のインストーラーとZIPを作成できるようにした

### [2026/10/09] v0.5.2

- 既存の画面・募集検出を保ち、ElectronからTauriへ実装を変更
- 常駐監視・通知・設定保存・起動処理をTauriのバックエンドで実行するようにした
- アプリの自動更新をTauriの署名付き更新に変更
- Electron標準のメニューバーを非表示にするようにした
- スクロール中もスレッド・友人戦募集・設定のタブを画面上部に残すようにした

### [2026/10/08] v0.5.1

- 開発起動時にelectron-updaterの読み込みでDynamic requireエラーになる問題を修正
- 開発に使用するpnpmを12.10.1に更新
- 指定ブラウザー・アプリが起動直後に異常終了しても起動成功と表示する問題を修正

### [2026/10/08] v0.5.0

- じゃんたまを起動するオプションを追加

### [2026/10/06] v0.4.0

- アプリ起動時にも保存済みの監視スレッドから有効期間内の募集を確認・通知
- 監視トグルをオンにした時点で、有効期間内の既存募集も確認・通知

### [2026/10/06] v0.3.0

- 指定したワッチョイの募集だけを通知する設定を追加
- ウィンドウサイズ・位置・最大化状態の保存と復元を追加

### [2026/10/05] v0.2.1

- ウィンドウの最小幅を400pxに変更し、狭い画面の表示を調整
- 更新間隔の初期値と下限を20秒に変更。設定画面から変更可能

### [2026/10/04] v0.2.0

- GitHubリリースの更新通知と、インストール版・AppImage版のアプリ内更新を追加
- 配布ファイル名の接頭辞を`sureneco_vバージョン`に統一
- 友人戦募集カードの上部にレス番号を明示
- 画面全体の余白と一覧・設定欄の高さを抑え、GUIをコンパクトに調整
- 締め切り済み・期限切れの募集への返信通知を抑止
- Windows通知の起動先を明示し、クリックでアプリを復元する処理と既定画面用ファイルの除去を追加
- デフォルトの友人戦通知フィルタに`数字+東|南`を追加

### [2026/10/04] v0.1.0

- スレッド選択、募集通知、締め検出、NG設定、トレイ常駐を実装
- Windows / Ubuntu向けビルド設定と検証コマンドを追加
- 募集本文の5桁のルームIDをクリックでコピーする機能を追加
- 募集検出の初期値に「四東・四南・三東・三南」と5桁の番号を含む条件を追加
- 初期フィルタに3・4、III・IV、Ⅲ・Ⅳと東・南を組み合わせた表記を追加
- 募集判定に5桁のルームIDを必須とし、レス参照をたどってIDを取得できるように変更
- 同じ環境向けのパッケージ作成で展開済みElectronを使用し、ZIP展開後のフォルダー名変更を回避
- Windows用インストーラーとZIP版の同時生成に対応

### [2026/10/04] v0.0.0

- リポジトリを作成
