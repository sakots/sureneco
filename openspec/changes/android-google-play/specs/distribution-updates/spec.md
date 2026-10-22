# Android配布と更新

## ADDED Requirements

### Requirement: Google Play提出用バンドル

Android版はGoogle Play提出用の署名付きAABを生成し、生成コマンドだけでは公開しないことを保証しなければならない（SHALL）。Androidの表示名は「スレネコアラート」、パッケージ名（applicationId）はsureneco.sakotsとし、PC版の名称・識別子は変更しない。versionNameはpackage.jsonに合わせ、versionCodeは公開ごとに増加させる。2026-10-21時点の提出要件としてAPI 36以上を対象にし、ARM64を含む。ネイティブ依存を含め16KBページサイズ端末での動作を検証する。

#### Scenario: AABの生成

- **WHEN** SDK/NDKとアップロード用署名鍵を設定してAndroid用配布コマンドを実行する
- **THEN** リリース用署名付きAABをrelease/へ生成し、Google PlayとGitHubには公開しない

#### Scenario: Androidアプリの名称と識別子

- **WHEN** Android向けAPKまたはAABを生成する
- **THEN** 表示名は「スレネコアラート」、パッケージ名と起動Activityのパッケージはsureneco.sakotsとなり、PC版の識別子を変更しない

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
- **THEN** 起動・非表示中のプッシュ受信・設定同期・監視停止・権限拒否・再起動後の設定保持の結果と、未確認事項を提示する


### Requirement: 配信設定とサーバー資格情報の分離

AndroidのAABには固定HTTPS APIと自前ntfyの接続設定だけを含め、サーバーの通知送信資格情報を含めてはならない（MUST NOT）。公開資料にはサーバーへ送る情報、保存期間、停止・削除方法とUnifiedPush・自前ntfy・中継アプリの利用を反映する。実際の自前ntfy・Androidと検証サーバーによる配信を確認してから提出準備完了とする。

#### Scenario: Android配布物の検査

- **WHEN** 提出用AABと変更差分・ログを検査する
- **THEN** サーバー送信用秘密情報が含まれず、公開用の接続先で登録・バックグラウンド受信・停止を検証できる

#### Scenario: 配信環境が未設定

- **WHEN** 自前ntfyまたは検証用サーバーに接続できない
- **THEN** AAB生成と実配信の検証状態を区別し、バックグラウンド通知が確認済みとは報告しない
