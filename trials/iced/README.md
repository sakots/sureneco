# Iced比較試作

Tauri版を置き換えず、Windows／Linux向けUIをIcedで試す。現行のRustライブラリーを`default-features = false`で再利用し、HTTP制約、保存、QuickJS上のTypeScript監視コアは同じものを使う。完全なRust判定コアへの移植ではなく、WebView／ReactとIcedのUI実装差を調べる試作である。

## 実装範囲

- スレッド一覧取得・手動／定期更新、監視トグル、募集一覧、ルームIDコピー、スレッドを開く。
- 現行コアで検証・保存する通常の設定画面（更新間隔、表示期間、検出・除外正規表現、板URL、NG／許可リスト）。試作用の保存先を分離し、本番の`sureneco`設定を上書きしない。未保存の編集は定期更新で失わず、保存失敗でも保持する。
- ネットワークとQuickJSは専用スレッドに置き、UIイベントループを止めない。通信・保存・通知の失敗は表示する。
- トレイから表示・更新・終了でき、利用できる環境ではウィンドウを閉じても監視を続ける。トレイを利用できない場合は閉じる操作で終了し、到達不能なバックグラウンドプロセスを残さない。画面にも明示的な終了操作を設ける。
- OS通知はWindowsの専用アプリIDとLinuxのD-Bus通知サーバーに対応する。接続・登録失敗は利用不可として表示する。自動起動、自動更新、雀魂ランチャー操作は対象外。本番Tauri版・PHP版の設定や登録は変更しない。
- 見た目はTauri版に合わせ、淡いグレーの背景・白いカード・緑のアクセントを使う。「スレッド」「友人戦募集」「設定」をタブで切り替え、候補と募集を横に並べない。保存先・接続情報は設定内の詳細へまとめる。設定項目は用途別カードに分ける。監視・保存・通知の処理は変更しない。
- Windowsのrelease版はGUIサブシステムを使い、余分なコンソールウィンドウを開かない。タブ切替時は本文を先頭へ戻し、設定を下までスクロールした位置を募集一覧へ持ち越さない。日時表示のタイムゾーンはUTCと明記する。
- 外観変更はLinux仮想画面の1120×820／400×600で確認した。3タブ、監視オン／オフ、設定保存、ルームIDの実コピー、詳細の開閉、タブ切替時のスクロール復帰を操作確認し、Windows x64実接続用releaseビルドにも成功。Windows実機の表示は未検証。画面証跡は`release/iced-visual-20261111/`（Git管理外）。

## 起動

リポジトリーのルートで実行する。通常利用では比較用featureを付けず、実際の5chへ接続する。

```sh
pnpm build
CARGO_TARGET_DIR="$PWD/src-tauri/target" \
  cargo run --release --manifest-path trials/iced/Cargo.toml
```

初回は候補を取得後に監視ボタンを有効にする。設定は「設定」で編集し、保存時に既存コアの値・正規表現・URL検証を受ける。NG／許可リストは1行1項目。雀魂ランチャーの設定値は保持するが、この版からは操作しない。既定の保存先はOSの設定ディレクトリー内の`sureneco-iced`。別の空ディレクトリーを使う場合は末尾に`-- --data-dir /absolute/trial-directory`を付ける。本番設定のコピーや移行は不要で、`config-location.json`による保存先切替も読み込まない。

Linuxでは通常のデスクトップセッションと日本語フォント（例: Noto Sans CJK JP）が必要。SSHで`DISPLAY`がない場合、そのままではGUIを起動できない。Windows向け実機検証・インストーラー作成はこの試作に含めない。

### 常駐と通知

- トレイメニューは「表示」「更新」「終了」。Windowsでは左クリックでも表示する。LinuxのAppIndicatorはクリックでホスト側のメニューを開く方式で、「表示」を選ぶ。
- LinuxはGTK 3の開発ファイル、Ayatana AppIndicator 3（または旧AppIndicator 3）の実行時ライブラリー、セッションD-Bus、StatusNotifier対応トレイホストが必要。GNOMEではAppIndicator対応拡張等が必要になる場合がある。旧XEmbed専用トレイは対象外。
- ホストと自分のアイコンの登録を確認してから「閉じると常駐」に切り替える。確認中・利用不可では閉じると終了する。常駐中にホストを失った場合は画面を再表示する。ウィンドウ内の「終了」とトレイの「終了」は通信・保存を待ってプロセスを終了する。
- Windows通知は`io.github.sakots.sureneco.iced`を現在ユーザーの`Software\Classes\AppUserModelId`へ登録し、ユーザーのスタートメニューに同じAppUserModelIDを持つ`sureneco-iced.lnk`を作成する。ZIP版を別フォルダーへ移した場合も起動時にリンク先を現在のEXEへ更新する。本番Tauri版のアプリID・ショートカットは使わない。Windows側で通知が無効の場合も利用不可を表示する。
- 自動起動・自動更新・ランチャー操作はまだ提供しない。Windowsの実通知・トレイの実機確認は別途必要。
- Windowsで`要素が見つかりません（0x80070490）`となる報告に対し、レジストリー登録だけでスタートメニューの通知ID付きショートカットがなかった点を修正。[Microsoftのデスクトップ通知要件](https://learn.microsoft.com/en-us/windows/win32/shell/enable-desktop-toast-with-appusermodelid)に従い、COM初期化後にショートカットを保存してから通知設定を取得する。登録・取得の失敗は引き続き表示する。
- 修正後は通知XMLの2テストが成功し、Windows用回帰テスト（日本語・空白を含むEXEパス、保存したAppUserModelIDの再読込、EXE移動後のリンク更新）のクロスコンパイルとWindows x64 releaseビルドに成功した。Windows用回帰テストの実行・実通知の解消確認はこのLinux環境では未実施。

### 実用化の確認（2026/11/11）

- `cargo test --release --manifest-path trials/iced/Cargo.toml --features comparison-fixture`で10テスト成功。設定ドラフト保持、数値入力・リスト境界、通知XMLエスケープ、トレイ登録・到達性の期限切れを確認した。
- Xvfb上の実GUIで、通常フォームから19秒設定の拒否、失敗・手動更新後の入力保持、21秒設定の保存と再起動後の保持、非編集のランチャー設定の保持を確認した。
- 専用D-Busと一時的なStatusNotifier／通知サーバーを使い、閉じても生存する常駐、トレイ経由の再表示・更新・正常終了、ホスト消失時の画面復帰、ホストなしで閉じると正常終了することを確認した。追加DAT投稿の読込とルームID `45678`を含む募集通知のD-Bus受信も確認した。本番の通知先へは送信していない。
- `cargo xwin check --release --target x86_64-pc-windows-msvc --manifest-path trials/iced/Cargo.toml --features comparison-fixture`に成功。Windows向けの型・依存ビルド確認であり、Windows上での起動・実通知・Explorerトレイの検証ではない。実デスクトップパネルとの相性とWindows実機は未検証。
- 画面とプロトコル受信の証跡はローカルの`release/iced-daily-use-20261111/`に保存した（Git管理外）。今回の機能追加後のメモリ再測定は行っていない。

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

以下はJSON設定・常駐なしの初期試作の参考値。実用化で追加した画面・トレイ・通知対応を含む現行版の測定値ではない。

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
