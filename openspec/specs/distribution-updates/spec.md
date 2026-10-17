# 配布とアプリ更新

## Purpose

WindowsとUbuntu向けの配布物の作成、署名と公開形式、およびアプリ内の更新動作を定義する。パッケージ形式に応じた適用方法を使い、利用者の操作なしで更新を適用せず監視を継続する。

## Requirements

### Requirement: 配布物の作成

配布物は以下のターゲットと名称で作成しなければならない（SHALL）。

Windows版はWindowsまたはUbuntu・WSL2でpnpm package:win、Linux版はUbuntu・WSL2でpnpm package:linuxを実行する。LinuxホストからWindows版を作るときはcargo-xwinをランナーにし、x86_64-pc-windows-msvcターゲットでNSISとZIPを作る。ZIPも同じWindowsターゲットの実行ファイルを使う。バージョンはpackage.jsonを正としてCargo.tomlも合わせる。生成物はrelease/へまとめ、配布名はsureneco_vVERSION_Setup.exe、sureneco_vVERSION_win.zip、sureneco_vVERSION.AppImage、sureneco_vVERSION_amd64.debに統一する。ZIPには実行ファイルを含め、NSISのpackage-typeマーカーは含めない。WindowsはWebView2を使用する。

#### Scenario: UbuntuからWindows版を作成

- **WHEN** Ubuntu・WSL2でpnpm package:winを実行する
- **THEN** cargo-xwinでWindows x64のNSISとZIPを生成し、ZIPにLinux実行ファイルやNSISのpackage-typeを含めない

### Requirement: 署名鍵と公開の分離

署名鍵と配布コマンドは以下の条件で扱わなければならない（SHALL）。

Tauriの署名鍵はGit管理外の.secrets/updater.keyまたはTAURI_SIGNING_PRIVATE_KEYから読み、公開鍵をtauri.conf.jsonへ設定する。配布コマンドは公開せず生成だけを行う。

#### Scenario: 生成と公開の分離

- **WHEN** 署名鍵を用意して配布コマンドを実行する
- **THEN** 配布物を生成し、GitHubへの公開は行わない

### Requirement: 更新の確認

更新確認は以下の頻度と継続条件を守らなければならない（SHALL）。

GitHub sakots/surenecoの正式リリースのlatest.jsonを起動時と6時間ごとに確認する。設定画面からも確認でき、新版を画面とOS通知で知らせる。現在より新しいバージョンだけを対象にし、更新失敗でも監視を続ける。確認・ダウンロードの重複実行を防ぐ。開発実行では更新を無効にする。

#### Scenario: 新版の検出

- **WHEN** 正式リリースのlatest.jsonに現在より新しいバージョンがある
- **THEN** 画面とOS通知で知らせる

#### Scenario: 更新確認の失敗

- **WHEN** 更新の確認に失敗する
- **THEN** 監視は継続する

#### Scenario: 開発実行

- **WHEN** 開発モードでアプリを実行する
- **THEN** アプリ更新を無効にする

### Requirement: 署名検証と明示的な適用

アプリ内更新は以下の署名検証と適用操作に従わなければならない（SHALL）。

NSIS・AppImage・DEB版はTauri updaterで署名を検証する。「ダウンロード」で取得し、「再起動して更新」を押したときだけ適用する。終了時には勝手に更新しない。DEBの適用ではOSの認証を受ける。NSISインストール時は実行ファイルと同じ場所へpackage-typeを作成し、Windows ZIP版ではGitHubリリースから手動更新する。

#### Scenario: ダウンロード後の終了

- **WHEN** 署名を検証して更新をダウンロードした後、通常終了する
- **THEN** 更新を勝手に適用しない

#### Scenario: 明示的な更新適用

- **WHEN** NSIS・AppImage・DEB版で「再起動して更新」を押す
- **THEN** 署名検証済みの更新を適用し、DEBではOS認証を受ける

#### Scenario: Windows ZIP版

- **WHEN** Windows ZIP版で新版が見つかる
- **THEN** GitHubリリースからの手動更新を案内する

### Requirement: 更新メタデータとElectron版からの切り替え

更新用配布と初回切り替えは以下の形式に従わなければならない（SHALL）。

全OSの配布物・.sigを同じrelease/へ集めてpnpm release:manifestでlatest.jsonを生成し、配布物・署名・latest.jsonを同じGitHub Releaseへ添付する。Electron用latest.yml・latest-linux.yml・blockmapは使用しない。Electron版からの初回導入は手動で行い、同じstate.jsonを読み込む。Electron版とTauri版は同時起動しない。同じバージョンの差し替えは更新として検出しない。

#### Scenario: 更新メタデータの生成

- **WHEN** 全OSの配布物と署名をrelease/に集めてpnpm release:manifestを実行する
- **THEN** latest.jsonを生成し、配布物と署名と同じGitHub Releaseへ添付する

#### Scenario: 同一バージョンの差し替え

- **WHEN** 正式リリースの同じバージョンの配布物を差し替える
- **THEN** 新しい更新として検出しない
