# sureneco 仕様の目次

現行仕様の正本は `openspec/specs/*/spec.md` です。このページは機能別仕様への入口と、開発・検証手順をまとめます。

OpenSpec導入時に従来の仕様書を整理したものです。新しい機能要件は追加していません。仕様内のシナリオは期待する動作を示し、実機検証済みであることを意味しません。

## 機能別仕様

| Capability | 内容 |
| --- | --- |
| [desktop-integration](../openspec/specs/desktop-integration/spec.md) | 画面、トレイ常駐、ウィンドウ状態、通知クリック |
| [thread-monitoring](../openspec/specs/thread-monitoring/spec.md) | 板とレスの取得、スレッド候補、独立した更新間隔 |
| [recruitment-detection](../openspec/specs/recruitment-detection/spec.md) | 募集・締めの検出、NG、通知許可、過去レス参照 |
| [room-actions](../openspec/specs/room-actions/spec.md) | ルームIDのコピー、操作結果の表示、雀魂の起動 |
| [settings-storage](../openspec/specs/settings-storage/spec.md) | 設定項目と初期値、入力検証、保存先の変更 |
| [security-boundary](../openspec/specs/security-boundary/spec.md) | Tauriコマンド、外部アクセス、OS操作の制限 |
| [distribution-updates](../openspec/specs/distribution-updates/spec.md) | 配布物の作成と署名、更新確認と適用 |

## OpenSpecでの変更手順

- `openspec/specs/`：現行仕様。通常の機能変更では、直接書き換えず変更の差分仕様から反映します。
- `openspec/changes/<変更名>/`：提案、差分仕様、必要な設計、タスク。進行中の変更を管理します。
- `openspec/changes/archive/`：実装・確認・現行仕様への反映を終えた変更の記録です。
- `openspec/config.yaml`：日本語での成果物作成、資料ファーストの開発順序、成果物ごとのルールを設定します。

1. 要件が曖昧なら `/opsx:explore` で調査し、変更内容を決めます。
2. `/opsx:propose <変更名または変更内容>` で提案・差分仕様・必要な設計・タスクを作成し、内容を確認します。
3. `/opsx:apply <変更名>` で資料更新、必要な振る舞いのテスト、最小実装、動作確認を進めます。
4. `openspec validate <変更名> --strict` で成果物の形式を検証します。アプリの動作確認は別途必要です。
5. 完了後に `/opsx:archive <変更名>` で差分を現行仕様へ反映し、変更をアーカイブします。事前に仕様だけを同期する必要がある場合は `/opsx:sync <変更名>` を使います。

導入前の開発履歴から架空の変更・完了タスクは作成せず、既存の更新履歴は [changelog.md](../changelog.md) に残します。

### CLIでの確認

```sh
openspec list
openspec list --specs
openspec show thread-monitoring --type spec
openspec validate --all --strict --no-interactive
```

## 検証

Vitestで募集解析、設定検証、NG、締め検出、通知の重複抑止、取得失敗からの回復、React画面とTauri通信を検証する。RustテストではQuickJS上の実コア、保存の置き換えと破損拒否、HTTPの許可URL・文字コード・サイズ制限を確認する。TypeScript型チェック、Viteと監視エンジンのビルド、Rustテスト・整形、明暗テーマ診断、git diff --checkを実施する。OS通知・トレイ・各OSのインストーラーは実機で別途確認する。

`pnpm check` は上記の自動チェックを実行します。OpenSpecの形式検証は別途実行してください。実施していない実機確認は未確認として記録します。

## 関連資料

- [README](../README.md)：概要、ダウンロード、基本操作、最新の更新履歴
- [使い方](usage.md)：監視・通知、設定フォルダ、雀魂の起動、更新、Electron版からの切り替え
- [開発](development.md)：構成、環境構築、起動とチェック
- [配布物の作成](packaging.md)：ビルド、署名、SSH先でのビルドと取得
- [Tauri移行時の構成](tauri-migration.md)：移行時の技術選択と環境構築の補足。現在の動作条件は機能別仕様を参照してください。
