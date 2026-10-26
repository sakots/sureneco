# Proposal

## Why

Windows／Linux版はログイン後に手動で起動する必要があり、常駐監視を開始し忘れる。利用者が設定画面から現在のユーザーのログイン時自動起動を有効・無効にできるようにする。

## What Changes

- Windows／Ubuntuの設定画面に「ログイン時に自動起動する」を追加する。未登録ならオフで、利用者が操作するまでOS設定を変更しない。
- OSの登録状態を読み取り、操作成功後の状態を表示する。権限・保存エラー時は成功表示にしない。
- 通常のウィンドウ表示・監視開始・single-instance動作を維持する。自動起動だけを理由に非表示起動へ変更しない。
- 初版で対象外だった自動起動を対象に追加する。AndroidとNodeサーバーには設定を表示・送信しない。
- Windowsのユーザー別Run登録、LinuxのXDG Autostartを使用し、DEB・AppImage・Windowsポータブル版の実行先を扱う。

## Capabilities

### New Capabilities

なし。

### Modified Capabilities

- `desktop-integration`: 自動起動の対象外指定を撤回し、ログイン時自動起動の設定・状態確認・解除・エラー処理を追加する。

## Impact

`src-tauri/src/desktop.rs`とdesktop配下の新規OS登録処理、React設定画面、`src/renderer/api.ts`・`src/core/types.ts`、関連テスト、`resources/installer.nsh`、使い方・更新履歴に影響する。Windowsの既存winreg依存を再利用し、新しい常駐サービスや管理者権限は要求しない。共通監視設定のstate.jsonとモバイル同期APIには項目を追加しない。OSログイン前の起動、隠れて起動する別設定、macOS、Android、サーバー自動起動は対象外。
