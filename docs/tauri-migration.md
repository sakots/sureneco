# Tauri移行

既存のReact画面とTypeScriptの募集検出・監視処理を保持し、ElectronをTauri 2へ置き換える。WindowsとUbuntuに対応する。

## 構成

- UI: React / TypeScript / Vite。限定されたTauriコマンドでバックエンドと通信する。
- 常駐監視: Rustの専用スレッド上のQuickJSで既存のTypeScriptコアを実行する。WebViewのタイマーに依存せず、非表示・最小化中も監視する。JavaScript正規表現の後読み等も保持する。Node.jsやChromiumは同梱しない。
- OS処理: RustでHTTP取得、Shift_JIS変換、設定の保存、通知、クリップボード、ブラウザー・アプリ起動を行う。外部URLとルームIDは既存のコアで検証する。
- ウィンドウ: トレイ常駐、多重起動防止、閉じる操作で非表示、サイズ・位置の保存、標準メニューなし。画面の作業領域が未確定で幅や高さが0の場合は、その領域でウィンドウを縮めない。
- 自動更新: Tauri updaterの署名付き更新へ変更する。Windows NSIS・Linux AppImage・DEBを対象にする。ZIPではGitHubの最新リリースを案内する。Electron版からの初回導入は手動で行う。

## 保存と配布

設定は既存のElectron版と同じディレクトリーのstate.jsonを使用し、保存形式を維持する。ウィンドウ情報はTauriの形式で別ファイルへ保存する。旧ファイルを変換する処理は設けない。

配布名はsureneco_vVERSION_amd64.deb、sureneco_vVERSION.AppImage、sureneco_vVERSION_Setup.exe、sureneco_vVERSION_win.zipとする。Tauriの更新にはlatest.jsonと署名ファイルを添付する。旧Electron向けlatest.yml・latest-linux.yml・blockmapはTauri版では生成しない。

## 検証

既存の募集検出・監視・UIテストに加え、QuickJS上での実行、保存失敗・破損、許可URL、起動引数、ネイティブHTTPのサイズ制限を確認する。Rustの整形・テスト・ビルド、テーマ診断、差分チェックを通す。Windowsの通知クリックとインストーラー、UbuntuのトレイとWebKit表示は実機で確認する。

Ubuntu・WSL2（Ubuntu）にはlibwebkit2gtk-4.1-dev、build-essential、libxdo-dev、libssl-dev、libayatana-appindicator3-dev、librsvg2-devが必要。WindowsにはRust MSVC、C++ Build Tools、WebView2が必要。Ubuntu・WSLからWindows x64版を作る場合はclang、llvm、lld、nsis、cmake、ninja-build、Rustのx86_64-pc-windows-msvcターゲット、cargo-xwinを用意し、pnpm package:winでクロスコンパイルする。出力先にはWindowsターゲットのサブディレクトリーを使い、ホストのLinux実行ファイルをZIPへ混ぜない。

参照: [Tauri前提条件](https://v2.tauri.app/start/prerequisites/)、[Tauri更新](https://v2.tauri.app/plugin/updater/)、[rquickjs](https://docs.rs/rquickjs/)。
