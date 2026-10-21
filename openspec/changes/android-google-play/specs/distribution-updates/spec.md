# Android配布と更新

## ADDED Requirements

### Requirement: Google Play提出用バンドル

Android版はGoogle Play提出用の署名付きAABを生成し、生成コマンドだけでは公開しないことを保証しなければならない（SHALL）。アプリIDはio.github.sakots.sureneco、versionNameはpackage.jsonに合わせ、versionCodeは公開ごとに増加させる。2026-10-21時点の提出要件としてAPI 36以上を対象にし、ARM64を含む。ネイティブ依存を含め16KBページサイズ端末での動作を検証する。

#### Scenario: AABの生成

- **WHEN** SDK/NDKとアップロード用署名鍵を設定してAndroid用配布コマンドを実行する
- **THEN** リリース用署名付きAABをrelease/へ生成し、Google PlayとGitHubには公開しない

#### Scenario: 署名情報が不足する

- **WHEN** 署名鍵または署名設定がない状態で提出用AABを作成する
- **THEN** 不足内容を示して失敗し、未署名またはデバッグ署名のファイルを提出可能な成果物として案内しない

### Requirement: Android署名情報の分離

Androidのアップロード用署名鍵とパスワードはGit管理外で扱い、ソース、ログ、配布物へ秘密情報を含めてはならない（MUST NOT）。デスクトップ更新用の署名鍵をAndroidの署名へ流用しない。

#### Scenario: 署名付きビルドの確認

- **WHEN** アップロード用署名鍵でAABを作成して変更差分を確認する
- **THEN** 鍵とパスワードは差分に含まれず、成果物の署名を確認できる

### Requirement: Android版の更新経路

Google Play向けAndroid版の更新はGoogle Playから行い、GitHubのデスクトップ用更新を取得・適用してはならない（MUST NOT）。設定画面には現在のバージョンとPlayで更新する案内を表示する。

#### Scenario: Androidでのアプリ更新画面

- **WHEN** Android版の設定画面を開く
- **THEN** GitHub用のダウンロード・再起動更新ボタンを表示せず、Playで更新する案内を表示する

### Requirement: 公開準備と検証結果の区別

Google Play向けの資料は署名、テストトラック、掲載情報、プライバシーポリシー、データセーフティ申告の準備手順を含み、実施済み・未実施の検証を区別しなければならない（SHALL）。ビルド成功を審査通過や公開完了として扱わない。

#### Scenario: 内部テストの準備

- **WHEN** AABを内部テストへ提出する準備を行う
- **THEN** 起動・表示中の監視・非表示時の停止・権限拒否・再起動後の設定保持の結果と、未確認事項を提示する
