# Iced比較試作

Tauri版を置き換えず、Windows／Linux向けUIをIcedで試す。現行のRustライブラリーを`default-features = false`で再利用し、HTTP制約、保存、QuickJS上のTypeScript監視コアは同じものを使う。完全なRust判定コアへの移植ではなく、WebView／ReactとIcedのUI実装差を調べる試作である。

## 実装範囲

- スレッド一覧取得・手動／定期更新、監視トグル、募集一覧、ルームIDコピー、スレッドを開く。
- 現行コアで検証・保存する設定編集。試作用の保存先を分離し、本番の`sureneco`設定を上書きしない。
- ネットワークとQuickJSは専用スレッドに置き、UIイベントループを止めない。通信・保存・通知の失敗は表示する。
- トレイ常駐、自動起動、自動更新、既存Tauriの全画面設定の完全な同等実装は比較対象外。機能差を隠して製品全体の優劣とは扱わない。
- OS通知はLinuxのD-Bus通知サーバーのみ対応する。接続できない場合とWindowsでは利用不可を表示する。雀魂ランチャーの起動操作は実装しない。閉じると通信・保存の完了を待って終了する。

## 起動

リポジトリーのルートで実行する。通常利用では比較用featureを付けず、実際の5chへ接続する。

```sh
pnpm build
CARGO_TARGET_DIR="$PWD/src-tauri/target" \
  cargo run --release --manifest-path trials/iced/Cargo.toml
```

初回は候補を取得後に監視ボタンを有効にする。設定は「設定 JSON」で編集し、「検証して保存」で反映する。既定の保存先はOSの設定ディレクトリー内の`sureneco-iced`。別の空ディレクトリーを使う場合は末尾に`-- --data-dir /absolute/trial-directory`を付ける。本番設定のコピーや移行は不要で、`config-location.json`による保存先切替も読み込まない。

Linuxでは通常のデスクトップセッションと日本語フォント（例: Noto Sans CJK JP）が必要。SSHで`DISPLAY`がない場合、そのままではGUIを起動できない。Windows向け実機検証・インストーラー作成はこの試作に含めない。

## 比較条件

両方をreleaseビルドし、同じ監視コア・同じ設定・同じローカルの板／dat応答を使う。応答差を排除する比較専用Cargo feature `comparison-fixture`は通常の配布には含めない。フィクスチャを有効にした場合は許可済みの板URLだけをローカルから読み、読み込み失敗を実ネットワークへフォールバックさせない。

測定はLinuxのプロセスツリー全体を対象にする。TauriのWebKit子プロセスを除外せず、RSSとPSSを区別し、UIの起動待ちと安定後のメモリを同じ手順・時間で記録する。実行順・回数・画面サイズ・ビルド形式・描画方式も記録する。単一プロセスのRSS、debugとreleaseの混在、Icedの画面なしモードとTauriのGUIの比較は行わない。

SSHにGUI表示先がない場合、仮想ディスプレイでの結果はその旨を明記する。実デスクトップ・実GPU・Windowsでの値と同一視しない。GUIが起動しなかった場合はメモリ比較の成功とは扱わない。

## 測定コマンド（Linux）

```sh
pnpm build
cargo build --release --manifest-path src-tauri/Cargo.toml --features comparison-fixture,tauri/custom-protocol
CARGO_TARGET_DIR="$PWD/src-tauri/target" \
  cargo build --release --manifest-path trials/iced/Cargo.toml --features comparison-fixture
python3 scripts/compare-native-ui.py \
  --tauri "$PWD/src-tauri/target/release/sureneco" \
  --iced "$PWD/src-tauri/target/release/sureneco-iced" \
  --display "$DISPLAY" --display-kind desktop \
  --output "$PWD/release/iced-comparison.json"
```

`tauri/custom-protocol`は、Tauri CLIを経由せずCargoで直接配布相当のHTMLを埋め込むために必要。付けない場合は開発用URLを参照して画面が表示されず、比較に使えない。

既存の出力ファイルには上書きしない。通常ビルドしか指定されていない、GUIがない、PSSを読めない、板／datを読めない場合は測定失敗にする。実行ごとに専用HOME／XDG領域を作り、同じ3候補・1監視スレッド・4投稿を投入する。許可ワッチョイを不一致にして両方のOS通知を抑え、本番の端末・通知設定は使わない。生データと実行ログは指定JSONとその`.artifacts`ディレクトリーに保存する。

既定は順序を交互にした各3回、ウィンドウ表示後2秒待って10秒測定する。起動時間は最初にウィンドウが表示された時刻で、初回描画完了の計測ではない。RSSは共有ページを重複計上するためPSSも併記する。ピークは安定待ち後のサンプル最大値で、起動時ピークではない。実行ファイルサイズには共有ライブラリー・フォント・インストーラーを含めない。画面構成はTauriの初期画面とIcedの候補／募集併記で異なり、製品機能の完全同等比較ではない。

## 実測結果（2026/11/11）

Linux x86_64、Xvfb 1280×900、両アプリのウィンドウ1120×820。Icedはtiny-skia、TauriはWebKitGTK。`DISPLAY=:121 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1`を設定した`dbus-run-session`内で、上記測定に`--display-kind virtual`を指定した。GPU描画・Windows・実デスクトップの結果ではない。

各3回とも板／dat読み込み・画面表示・PSS取得に成功。値は各実行の中央値をさらに3回で中央値にしたもの。

| 指標 | Tauri | Iced |
| --- | ---: | ---: |
| プロセスツリーRSS | 389.61 MiB | 60.81 MiB |
| プロセスツリーPSS | 200.83 MiB | 49.58 MiB |
| ウィンドウ表示まで | 0.655秒 | 0.077秒 |
| 実行ファイル | 28.78 MiB | 22.25 MiB |
| 最大プロセス数（各回の中央値） | 6 | 1 |

この条件ではPSSが75.3%少ない。ただしトレイ等の機能差に加え、独立したCargo.lockによる依存パッチの差もある（Tauri／Icedの順にserde_json 1.0.151／1.0.154、notify-rust 4.18.2／4.19.0）。差の全量をWebViewだけの寄与とは断定しない。起動時間はウォーム／コールドキャッシュを分離していない。

生データはローカルの`release/iced-comparison-20261111-software.json`、画面証跡は`release/iced-prototype-visual-20261111/`に保存した（生成物としてGit管理外）。配布用プロトコルを付けない初回ビルドの画面未表示は失敗として除外し、上表に混ぜていない。

仮想画面で日本語表示、候補3件・募集表示、監視オン／オフ保存、19秒設定の拒否、21秒設定の保存・正常終了・再起動後の保持、ルームID `34567`の実クリップボードコピー、募集期限切れと締め切りの区別、通知サーバー接続失敗表示を確認した。共通コアのRustテストは27件成功。ブラウザー起動先の実操作、OS通知の実配信、Windowsでの動作は未検証。
