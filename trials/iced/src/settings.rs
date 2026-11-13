use iced::{
    widget::{button, column, container, pick_list, row, text_editor, text_input},
    Element, Length,
};
use serde_json::Value;

use crate::appearance;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    UpdateSec,
    ThreadUpdateSec,
    ElapsedDays,
    EmphasisSec,
    ThreadTitleRegex,
    NgThreadTitleRegex,
    YujinsenRegex,
    ClosedYujinsenRegex,
    Url,
    NgWords,
    NgIds,
    NgWatchois,
    AllowedWatchois,
    LauncherMode,
    LauncherPath,
    LauncherArgs,
    LauncherProfile,
    LauncherUserDataDir,
    RecruitmentFilter,
}

impl Field {
    const ALL: [Self; 19] = [
        Self::UpdateSec,
        Self::ThreadUpdateSec,
        Self::ElapsedDays,
        Self::EmphasisSec,
        Self::ThreadTitleRegex,
        Self::NgThreadTitleRegex,
        Self::YujinsenRegex,
        Self::ClosedYujinsenRegex,
        Self::Url,
        Self::NgWords,
        Self::NgIds,
        Self::NgWatchois,
        Self::AllowedWatchois,
        Self::LauncherMode,
        Self::LauncherPath,
        Self::LauncherArgs,
        Self::LauncherProfile,
        Self::LauncherUserDataDir,
        Self::RecruitmentFilter,
    ];

    fn key(self) -> &'static str {
        match self {
            Self::UpdateSec => "update_sec",
            Self::ThreadUpdateSec => "thread_update_sec",
            Self::ElapsedDays => "elapsed_days",
            Self::EmphasisSec => "emphasis_sec",
            Self::ThreadTitleRegex => "thread_title_regex",
            Self::NgThreadTitleRegex => "ng_thread_title_regex",
            Self::YujinsenRegex => "yujinsen_regex",
            Self::ClosedYujinsenRegex => "closed_yujinsen_regex",
            Self::Url => "url",
            Self::NgWords => "ng_words",
            Self::NgIds => "ng_ids",
            Self::NgWatchois => "ng_watchois",
            Self::AllowedWatchois => "allowed_watchois",
            Self::LauncherMode => "launcher_mode",
            Self::LauncherPath => "launcher_path",
            Self::LauncherArgs => "launcher_args",
            Self::LauncherProfile => "launcher_profile",
            Self::LauncherUserDataDir => "launcher_user_data_dir",
            Self::RecruitmentFilter => "recruitment_filter",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::UpdateSec => "友人戦募集の更新間隔（秒）",
            Self::ThreadUpdateSec => "スレッド一覧の更新間隔（秒）",
            Self::ElapsedDays => "候補の経過日数（日）",
            Self::EmphasisSec => "新規募集の有効期間（秒）",
            Self::ThreadTitleRegex => "スレッド名の正規表現",
            Self::NgThreadTitleRegex => "除外するスレッド名の正規表現（空欄可）",
            Self::YujinsenRegex => "募集レスの正規表現",
            Self::ClosedYujinsenRegex => "締め切りレスの正規表現",
            Self::Url => "板URL（5ch.io / 5ch.net の HTTPS）",
            Self::NgWords => "NGワード（1行1項目）",
            Self::NgIds => "NG ID（1行1項目）",
            Self::NgWatchois => "NGワッチョイ（1行1項目）",
            Self::AllowedWatchois => "通知を許可するワッチョイ（空欄なら全員・1行1項目）",
            Self::LauncherMode => "起動方法",
            Self::LauncherPath => "実行ファイルのパス",
            Self::LauncherArgs => "起動引数（1行1引数）",
            Self::LauncherProfile => "プロファイル名（例: Default / Profile 1）",
            Self::LauncherUserDataDir => "ユーザーデータディレクトリ（空欄可）",
            Self::RecruitmentFilter => "募集フィルタ",
        }
    }

    fn numeric(self) -> bool {
        matches!(
            self,
            Self::UpdateSec | Self::ThreadUpdateSec | Self::ElapsedDays | Self::EmphasisSec
        )
    }

    fn list(self) -> bool {
        matches!(
            self,
            Self::NgWords
                | Self::NgIds
                | Self::NgWatchois
                | Self::AllowedWatchois
                | Self::LauncherArgs
        )
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Section {
    All,
    Fetch,
    Patterns,
}

impl Section {
    fn contains(self, field: Field) -> bool {
        match self {
            Self::All => true,
            Self::Fetch => field.numeric() || field == Field::Url,
            Self::Patterns => matches!(
                field,
                Field::ThreadTitleRegex
                    | Field::NgThreadTitleRegex
                    | Field::YujinsenRegex
                    | Field::ClosedYujinsenRegex
                    | Field::RecruitmentFilter
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LauncherMode {
    Default,
    Browser,
    Application,
}

impl LauncherMode {
    const ALL: [Self; 3] = [Self::Default, Self::Browser, Self::Application];

    fn key(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Browser => "browser",
            Self::Application => "application",
        }
    }
}

impl std::fmt::Display for LauncherMode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Default => "既定ブラウザー",
            Self::Browser => "Chrome / Edge（プロファイル指定）",
            Self::Application => "指定アプリ（雀魂・Steamなど）",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecruitmentFilter {
    Regex,
    Loose,
}

impl RecruitmentFilter {
    const ALL: [Self; 2] = [Self::Regex, Self::Loose];

    fn key(self) -> &'static str {
        match self {
            Self::Regex => "regex",
            Self::Loose => "loose",
        }
    }
}

impl std::fmt::Display for RecruitmentFilter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Regex => "通常",
            Self::Loose => "緩め（誤通知が増えるかもしれません）",
        })
    }
}

#[derive(Debug, Clone)]
pub enum Message {
    Input(Field, String),
    List(Field, text_editor::Action),
}

struct Draft {
    field: Field,
    text: String,
    list: Option<text_editor::Content>,
    dirty: bool,
}

impl Draft {
    fn load(&mut self, settings: &Value) {
        let value = &settings[self.field.key()];
        self.text = if self.field.list() {
            value
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        } else if self.field.numeric() {
            value
                .as_number()
                .map(ToString::to_string)
                .unwrap_or_default()
        } else {
            value
                .as_str()
                .unwrap_or(if self.field == Field::RecruitmentFilter {
                    "regex"
                } else {
                    ""
                })
                .to_owned()
        };
        if self.field.list() {
            self.list = Some(text_editor::Content::with_text(&self.text));
        }
        self.dirty = false;
    }

    fn differs(&self, settings: &Value) -> bool {
        let value = &settings[self.field.key()];
        if let Some(content) = &self.list {
            let mut expected = value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .flat_map(|value| value.split('\n'))
                .peekable();
            if expected.peek().is_none() {
                return content.line_count() != 1
                    || content.line(0).is_some_and(|line| !line.is_empty());
            }
            !content.lines().all(|line| expected.next() == Some(&*line))
                || expected.next().is_some()
        } else if self.field.numeric() {
            match parse_integer(&self.text) {
                Ok(number) => Some(number) != value.as_i64(),
                Err(()) => true,
            }
        } else {
            let expected = value
                .as_str()
                .or_else(|| (self.field == Field::RecruitmentFilter).then_some("regex"));
            expected != Some(self.text.as_str())
        }
    }

    fn view(&self, enabled: bool) -> Element<'_, Message> {
        let control: Element<'_, Message> = if let Some(content) = &self.list {
            let mut editor = text_editor(content)
                .height(88)
                .size(14)
                .padding(8)
                .style(appearance::editor);
            if enabled {
                let field = self.field;
                editor = editor.on_action(move |action| Message::List(field, action));
            }
            editor.into()
        } else {
            let mut input = text_input("", &self.text)
                .size(14)
                .padding(8)
                .style(appearance::input);
            if enabled {
                let field = self.field;
                input = input.on_input(move |value| Message::Input(field, value));
            }
            input.into()
        };

        column![crate::label(self.field.label()).size(13), control]
            .spacing(6)
            .width(Length::Fill)
            .into()
    }
}

pub struct Form {
    original: Value,
    fields: [Draft; 19],
    defaults_pending: bool,
}

impl Form {
    pub fn new() -> Self {
        Self {
            original: Value::Null,
            defaults_pending: false,
            fields: Field::ALL.map(|field| Draft {
                field,
                text: String::new(),
                list: field.list().then(text_editor::Content::new),
                dirty: false,
            }),
        }
    }

    // Snapshots update the save baseline and pristine controls, never an edited draft.
    pub fn refresh(&mut self, settings: &Value) {
        for draft in &mut self.fields {
            if draft.dirty {
                draft.dirty = draft.differs(settings);
            } else {
                draft.load(settings);
            }
        }
        self.original = settings.clone();
    }

    // Called after an acknowledged successful settings save.
    pub fn reset(&mut self, settings: &Value) {
        self.original = settings.clone();
        self.defaults_pending = false;
        for draft in &mut self.fields {
            draft.load(settings);
        }
    }

    pub fn restore_defaults(&mut self, defaults: &Value, section: Section) {
        self.defaults_pending = true;
        for draft in self
            .fields
            .iter_mut()
            .filter(|draft| section.contains(draft.field))
        {
            draft.load(defaults);
            draft.dirty = draft.differs(&self.original);
        }
    }

    pub fn dirty(&self) -> bool {
        self.defaults_pending || self.fields.iter().any(|draft| draft.dirty)
    }

    fn recruitment_regex_editable(&self) -> bool {
        self.fields
            .iter()
            .find(|draft| draft.field == Field::RecruitmentFilter)
            .is_none_or(|draft| draft.text != RecruitmentFilter::Loose.key())
    }

    pub fn update(&mut self, message: Message) {
        match message {
            Message::Input(field, value) => {
                if field == Field::YujinsenRegex && !self.recruitment_regex_editable() {
                    return;
                }
                if let Some(draft) = self
                    .fields
                    .iter_mut()
                    .find(|draft| draft.field == field && !field.list())
                {
                    draft.text = value;
                    draft.dirty = draft.differs(&self.original);
                }
            }
            Message::List(field, action) => {
                if let Some(draft) = self.fields.iter_mut().find(|draft| draft.field == field) {
                    if let Some(content) = &mut draft.list {
                        let edited = matches!(&action, text_editor::Action::Edit(_));
                        content.perform(action);
                        if edited {
                            draft.dirty = draft.differs(&self.original);
                        }
                    }
                }
            }
        }
    }

    pub fn candidate(&self) -> Result<Value, String> {
        let mut settings = self.original.clone();
        let object = settings
            .as_object_mut()
            .ok_or("保存済み設定を取得できません。")?;
        for draft in self.fields.iter().filter(|draft| draft.dirty) {
            let value = if let Some(content) = &draft.list {
                Value::Array(
                    parse_list(&content.text())
                        .into_iter()
                        .map(Value::String)
                        .collect(),
                )
            } else if draft.field.numeric() {
                parse_integer(&draft.text).map(Value::from).map_err(|()| {
                    format!(
                        "{}: 整数を入力してください（入力中の値は保持しています）。",
                        draft.field.label()
                    )
                })?
            } else {
                Value::String(draft.text.clone())
            };
            object.insert(draft.field.key().into(), value);
        }
        Ok(settings)
    }

    pub(super) fn view(
        &self,
        enabled: bool,
        defaults_available: bool,
    ) -> Element<'_, crate::Message> {
        let [update, thread_update, elapsed, emphasis, thread_title, ng_thread_title, recruitment, closed, url, ng_words, ng_ids, ng_watchois, allowed_watchois, launcher_mode, launcher_path, launcher_args, launcher_profile, launcher_user_data_dir, recruitment_filter] =
            &self.fields;
        let selected_filter = RecruitmentFilter::ALL
            .into_iter()
            .find(|mode| mode.key() == recruitment_filter.text);
        let filter_picker: Element<'_, Message> = if enabled {
            pick_list(RecruitmentFilter::ALL, selected_filter, |mode| {
                Message::Input(Field::RecruitmentFilter, mode.key().into())
            })
            .into()
        } else {
            crate::label(
                selected_filter
                    .map(|mode| mode.to_string())
                    .unwrap_or_else(|| recruitment_filter.text.clone()),
            )
            .size(14)
            .into()
        };
        let selected = LauncherMode::ALL
            .into_iter()
            .find(|mode| mode.key() == launcher_mode.text);
        let mode_picker: Element<'_, Message> = if enabled {
            pick_list(LauncherMode::ALL, selected, |mode| {
                Message::Input(Field::LauncherMode, mode.key().into())
            })
            .into()
        } else {
            crate::label(
                selected
                    .map(|mode| mode.to_string())
                    .unwrap_or_else(|| launcher_mode.text.clone()),
            )
            .size(14)
            .into()
        };
        let mut launcher = column![crate::label("起動方法").size(13), mode_picker,].spacing(12);
        match selected {
            Some(LauncherMode::Browser) => {
                launcher = launcher
                    .push(launcher_path.view(enabled))
                    .push(launcher_profile.view(enabled))
                    .push(launcher_user_data_dir.view(enabled))
                    .push(crate::label("Chrome は chrome://version、Edge は edge://version の「実行可能ファイルのパス」「プロフィール パス」で確認できます。プロフィール パスの末尾がプロファイル名、その親がユーザーデータディレクトリです。").size(13).style(appearance::muted));
            }
            Some(LauncherMode::Application) => {
                launcher = launcher
                    .push(launcher_path.view(enabled))
                    .push(launcher_args.view(enabled))
                    .push(crate::label("1行1引数。空白を含む引数も引用符は不要です。Steam は -applaunch と対象の App ID を別々の行に入力してください。").size(13).style(appearance::muted));
            }
            _ => {}
        }
        launcher = launcher.push(
            crate::label("自動起動・自動更新はこの試作では利用できません。")
                .size(13)
                .style(appearance::muted),
        );

        column![
            settings_card(
                "取得と通知",
                column![
                    numeric_row(update, thread_update, enabled),
                    numeric_row(elapsed, emphasis, enabled),
                    crate::label("更新間隔は20秒以上、日数・有効期間は1以上（上限2147483）。")
                        .size(13)
                        .style(appearance::muted),
                    url.view(enabled),
                    crate::label("板URLの変更時は監視対象と取得済みレス番号をリセットします。")
                        .size(13)
                        .style(appearance::muted),
                ]
                .spacing(12),
                Some(Section::Fetch),
                enabled && defaults_available,
            ),
            settings_card(
                "検出する正規表現",
                column![
                    crate::label("大文字・小文字は区別しません。除外するスレッド名は空欄にできます。")
                        .size(13)
                        .style(appearance::muted),
                    column![crate::label("募集フィルタ").size(13), filter_picker].spacing(6),
                    thread_title.view(enabled),
                    ng_thread_title.view(enabled),
                    recruitment.view(enabled && self.recruitment_regex_editable()),
                    closed.view(enabled),
                ]
                .spacing(12),
                Some(Section::Patterns),
                enabled && defaults_available,
            ),
            settings_card("雀魂の起動", launcher, None, false),
            settings_card(
                "NG・通知対象",
                column![
                    crate::label("1行1項目。本文は部分一致、ID・ワッチョイは完全一致で除外します。")
                        .size(13)
                        .style(appearance::muted),
                    ng_words.view(enabled),
                    ng_ids.view(enabled),
                    ng_watchois.view(enabled),
                    allowed_watchois.view(enabled),
                    crate::label("通知対象はワッチョイ全体で指定（空欄なら全員）。NGが優先され、通知対象外の募集も一覧に表示します。")
                        .size(13)
                        .style(appearance::muted),
                    crate::label("空行は無視します。入力中の前後の空白は保持し、保存時に空白除去・重複整理を行います。")
                        .size(13)
                        .style(appearance::muted),
                ]
                .spacing(12),
                None,
                false,
            ),
        ]
        .spacing(12)
        .width(Length::Fill)
        .into()
    }
}

fn numeric_row<'a>(first: &'a Draft, second: &'a Draft, enabled: bool) -> Element<'a, Message> {
    row![
        container(first.view(enabled)).width(280),
        container(second.view(enabled)).width(280),
    ]
    .spacing(12)
    .width(Length::Fill)
    .wrap()
    .into()
}

fn settings_card<'a>(
    title: &'static str,
    content: impl Into<Element<'a, Message>>,
    section: Option<Section>,
    reset_enabled: bool,
) -> Element<'a, crate::Message> {
    let mut heading = row![crate::label(title).size(16).width(Length::Fill)]
        .spacing(10)
        .align_y(iced::Alignment::Center);
    if let Some(section) = section {
        heading = heading.push(
            button(crate::label("デフォルトに戻す").size(13))
                .padding([6, 12])
                .style(appearance::secondary)
                .on_press_maybe(reset_enabled.then_some(crate::Message::RestoreDefaults(section))),
        );
    }
    let mut body = column![heading];
    if section.is_some() {
        body = body.push(
            crate::label("この区分だけを戻します。「保存」で反映します。")
                .size(12)
                .style(appearance::muted),
        );
    }
    container(
        body.push(content.into().map(crate::Message::Settings))
            .spacing(12)
            .width(Length::Fill),
    )
    .padding(16)
    .width(Length::Fill)
    .style(appearance::panel)
    .into()
}

fn parse_integer(input: &str) -> Result<i64, ()> {
    let digits = input.strip_prefix('-').unwrap_or(input);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(());
    }
    input.parse().map_err(|_| ())
}

fn parse_list(input: &str) -> Vec<String> {
    input
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn saved() -> Value {
        json!({
            "update_sec": 20, "thread_update_sec": 300, "elapsed_days": 14,
            "emphasis_sec": 600, "thread_title_regex": "雀魂", "ng_thread_title_regex": "",
            "yujinsen_regex": "募集", "closed_yujinsen_regex": "〆", "url": "https://egg.5ch.io/mj/",
            "ng_words": ["  meaningful  ", "embedded\nnewline"], "ng_ids": [], "ng_watchois": [], "allowed_watchois": [],
            "launcher_mode": "application", "launcher_path": "/opt/mahjong soul",
            "launcher_args": ["--profile", "  untouched  "], "launcher_profile": "Profile 1",
            "launcher_user_data_dir": "/home/person/profile", "future": {"nested": [1, false, null]}
        })
    }

    #[test]
    fn recruitment_mode_preserves_regex_draft_and_snapshot_save_lifecycle() {
        let original = saved();
        let mut form = Form::new();
        form.refresh(&original);
        assert!(!form.dirty());
        form.update(Message::Input(Field::RecruitmentFilter, "regex".into()));
        assert!(!form.dirty());
        form.update(Message::Input(
            Field::YujinsenRegex,
            "custom recruitment".into(),
        ));
        form.update(Message::Input(Field::RecruitmentFilter, "loose".into()));
        assert!(!form.recruitment_regex_editable());
        form.update(Message::Input(Field::YujinsenRegex, "ignored".into()));
        form.update(Message::Input(
            Field::ClosedYujinsenRegex,
            "custom close".into(),
        ));
        let candidate = form.candidate().unwrap();
        assert_eq!(candidate["recruitment_filter"], "loose");
        assert_eq!(candidate["yujinsen_regex"], "custom recruitment");
        assert_eq!(candidate["closed_yujinsen_regex"], "custom close");
        // Rejected saves and periodic snapshots must not clear either draft.
        form.refresh(&original);
        assert_eq!(form.candidate().unwrap(), candidate);
        form.update(Message::Input(Field::RecruitmentFilter, "regex".into()));
        assert!(form.recruitment_regex_editable());
        assert_eq!(
            form.candidate().unwrap()["yujinsen_regex"],
            "custom recruitment"
        );
        form.reset(&candidate);
        assert!(!form.dirty());
        assert!(!form.recruitment_regex_editable());
    }

    #[test]
    fn recruitment_mode_defaults_reset_patterns_and_all_but_not_fetch() {
        let defaults = saved();
        let mut original = saved();
        original["recruitment_filter"] = json!("loose");
        for section in [Section::Patterns, Section::All] {
            let mut form = Form::new();
            form.reset(&original);
            form.restore_defaults(&defaults, Section::Fetch);
            assert_eq!(form.candidate().unwrap()["recruitment_filter"], "loose");
            form.restore_defaults(&defaults, section);
            form.refresh(&original);
            let candidate = form.candidate().unwrap();
            assert_eq!(candidate["recruitment_filter"], "regex");
            assert!(form.recruitment_regex_editable());
            assert!(form.dirty());
            form.reset(&candidate);
            assert!(!form.dirty());
        }
    }

    #[test]
    fn reverting_edits_removes_unsaved_changes_for_numbers_text_and_lists() {
        let original = saved();
        let mut form = Form::new();
        form.refresh(&original);
        for (field, changed, restored) in [
            (Field::UpdateSec, "25", "20"),
            (Field::ThreadTitleRegex, "edited", "雀魂"),
        ] {
            form.update(Message::Input(field, changed.into()));
            assert!(form.dirty());
            form.update(Message::Input(field, restored.into()));
            assert!(!form.dirty());
            assert_eq!(form.candidate().unwrap(), original);
        }
        form.update(Message::List(
            Field::NgWords,
            text_editor::Action::Edit(text_editor::Edit::Paste(std::sync::Arc::new("X".into()))),
        ));
        assert!(form.dirty());
        form.update(Message::List(
            Field::NgWords,
            text_editor::Action::Edit(text_editor::Edit::Backspace),
        ));
        assert!(!form.dirty());
        assert_eq!(form.candidate().unwrap(), original);
    }

    #[test]
    fn defaults_replace_invalid_drafts_and_launcher_but_preserve_unknown_settings() {
        let mut original = saved();
        original["update_sec"] = json!(35);
        let mut defaults = saved();
        defaults["ng_words"] = json!([]);
        defaults["launcher_path"] = json!("");
        defaults["launcher_mode"] = json!("default");
        defaults["launcher_args"] = json!([]);
        defaults["launcher_profile"] = json!("");
        defaults["launcher_user_data_dir"] = json!("");
        let mut form = Form::new();
        form.refresh(&original);
        form.update(Message::Input(Field::UpdateSec, "-".into()));
        form.restore_defaults(&defaults, Section::All);
        form.refresh(&original);
        let candidate = form.candidate().unwrap();
        assert_eq!(candidate["update_sec"], 20);
        assert_eq!(candidate["ng_words"], json!([]));
        for field in [
            Field::LauncherMode,
            Field::LauncherPath,
            Field::LauncherArgs,
            Field::LauncherProfile,
            Field::LauncherUserDataDir,
        ] {
            assert_eq!(candidate[field.key()], defaults[field.key()]);
        }
        assert_eq!(candidate["future"], original["future"]);
        assert!(form.dirty());
        form.reset(&candidate);
        assert!(!form.dirty());
    }

    #[test]
    fn fetch_defaults_preserve_other_section_drafts_and_save_baseline() {
        let defaults = saved();
        let mut original = saved();
        original["update_sec"] = json!(45);
        original["thread_update_sec"] = json!(900);
        original["elapsed_days"] = json!(30);
        original["emphasis_sec"] = json!(1200);
        original["url"] = json!("https://egg.5ch.net/mj/");
        let mut form = Form::new();
        form.refresh(&original);
        form.update(Message::Input(Field::YujinsenRegex, "draft-regex".into()));
        form.update(Message::Input(Field::LauncherPath, "/draft/game".into()));
        form.update(Message::List(
            Field::NgIds,
            text_editor::Action::Edit(text_editor::Edit::Paste(std::sync::Arc::new(
                "draft-id".into(),
            ))),
        ));
        form.restore_defaults(&defaults, Section::Fetch);
        let mut expected = original.clone();
        for key in [
            "update_sec",
            "thread_update_sec",
            "elapsed_days",
            "emphasis_sec",
            "url",
        ] {
            expected[key] = defaults[key].clone();
        }
        expected["yujinsen_regex"] = json!("draft-regex");
        expected["launcher_path"] = json!("/draft/game");
        expected["ng_ids"] = json!(["draft-id"]);
        assert_eq!(form.candidate().unwrap(), expected);
        form.refresh(&original);
        assert_eq!(form.candidate().unwrap(), expected);
        assert!(form.dirty());
        form.reset(&expected);
        assert!(!form.dirty());
    }

    #[test]
    fn pattern_defaults_preserve_invalid_fetch_draft_and_other_edits() {
        let defaults = saved();
        let mut original = saved();
        for key in [
            "thread_title_regex",
            "ng_thread_title_regex",
            "yujinsen_regex",
            "closed_yujinsen_regex",
        ] {
            original[key] = json!("custom-pattern");
        }
        let mut form = Form::new();
        form.refresh(&original);
        form.update(Message::Input(Field::UpdateSec, "-".into()));
        form.update(Message::Input(Field::LauncherPath, "/draft/game".into()));
        form.restore_defaults(&defaults, Section::Patterns);
        assert!(form.candidate().is_err());
        assert_eq!(form.fields[0].text, "-");
        form.update(Message::Input(Field::UpdateSec, "45".into()));
        let mut expected = original.clone();
        for key in [
            "thread_title_regex",
            "ng_thread_title_regex",
            "yujinsen_regex",
            "closed_yujinsen_regex",
        ] {
            expected[key] = defaults[key].clone();
        }
        expected["update_sec"] = json!(45);
        expected["launcher_path"] = json!("/draft/game");
        form.refresh(&original);
        assert_eq!(form.candidate().unwrap(), expected);
        assert!(form.dirty());
    }

    #[test]
    fn unchanged_defaults_still_require_save_until_acknowledged() {
        let defaults = saved();
        let mut form = Form::new();
        form.reset(&defaults);
        assert!(!form.dirty());
        form.restore_defaults(&defaults, Section::Patterns);
        assert!(form.dirty());
        // Polling and failed saves do not acknowledge the restoration.
        form.refresh(&defaults);
        assert!(form.dirty());
        assert_eq!(form.candidate().unwrap(), defaults);
        form.reset(&defaults);
        assert!(!form.dirty());
    }

    #[test]
    fn patches_only_edited_fields_and_preserves_original_values() {
        let original = saved();
        let mut form = Form::new();
        form.refresh(&original);
        assert_eq!(form.candidate().unwrap(), original);
        form.update(Message::Input(Field::UpdateSec, "21".into()));
        let mut expected = original;
        expected["update_sec"] = json!(21);
        assert_eq!(form.candidate().unwrap(), expected);
    }

    #[test]
    fn incomplete_or_invalid_numbers_keep_their_exact_draft() {
        let mut form = Form::new();
        form.refresh(&saved());
        for input in [
            "",
            "-",
            "1.",
            "1e",
            "20.5",
            "abc",
            " 20",
            "20 ",
            "+20",
            "99999999999999999999999999999999",
        ] {
            form.update(Message::Input(Field::UpdateSec, input.into()));
            assert!(form.candidate().is_err(), "{input:?}");
            assert_eq!(form.fields[0].text, input);
            assert!(form.dirty());
        }
        // Semantic ranges remain the shared backend's responsibility.
        form.update(Message::Input(Field::UpdateSec, "19".into()));
        assert_eq!(form.candidate().unwrap()["update_sec"], 19);
    }

    #[test]
    fn lists_ignore_blank_lines_but_preserve_meaningful_whitespace_and_duplicates() {
        assert_eq!(
            parse_list("\n \n\t\r\n  NG text  \r\nID\nID\n"),
            vec!["  NG text  ", "ID", "ID"]
        );
        assert!(parse_list("\n\r\n \t\n").is_empty());
        assert_eq!(parse_list("a\rb\n全角　空白"), vec!["a\rb", "全角　空白"]);
    }

    #[test]
    fn refresh_and_rejected_save_keep_dirty_fields_until_reset() {
        let mut form = Form::new();
        let mut snapshot = saved();
        form.refresh(&snapshot);
        form.update(Message::Input(Field::UpdateSec, "-".into()));
        assert!(form.candidate().is_err());
        snapshot["thread_update_sec"] = json!(400);
        snapshot["future"] = json!({"new": true});
        form.refresh(&snapshot);
        assert_eq!(form.fields[0].text, "-");
        assert_eq!(form.fields[1].text, "400");
        assert!(form.dirty());
        form.update(Message::Input(Field::UpdateSec, "19".into()));
        // A backend-rejected candidate is not an acknowledgement and cannot clear drafts.
        let _rejected_candidate = form.candidate().unwrap();
        form.refresh(&snapshot);
        assert_eq!(form.candidate().unwrap()["update_sec"], 19);
        assert_eq!(form.candidate().unwrap()["future"], snapshot["future"]);
        assert!(form.dirty());
        form.reset(&snapshot);
        assert!(!form.dirty());
        assert_eq!(form.candidate().unwrap(), snapshot);
    }

    #[test]
    fn successful_save_acknowledgement_replaces_draft_with_canonical_values() {
        let mut form = Form::new();
        let mut snapshot = saved();
        form.refresh(&snapshot);
        form.update(Message::Input(Field::UpdateSec, "021".into()));
        snapshot["update_sec"] = json!(21);
        form.refresh(&snapshot);
        assert_eq!(form.fields[0].text, "021");
        form.reset(&snapshot);
        assert_eq!(form.fields[0].text, "21");
        assert!(!form.dirty());
    }

    #[test]
    fn edited_list_survives_snapshot_and_save_failure_without_trimming_text() {
        let mut form = Form::new();
        let mut snapshot = saved();
        snapshot["ng_words"] = json!([]);
        form.refresh(&snapshot);
        form.update(Message::List(
            Field::NgWords,
            text_editor::Action::Edit(text_editor::Edit::Paste(std::sync::Arc::new(
                "\n  雀魂 NG  \n\nID\n".to_owned(),
            ))),
        ));
        assert_eq!(
            form.candidate().unwrap()["ng_words"],
            json!(["  雀魂 NG  ", "ID"])
        );
        snapshot["ng_words"] = json!(["保存済み"]);
        // Failed saves do not call reset; an ensuing snapshot must leave this list dirty.
        form.refresh(&snapshot);
        assert_eq!(
            form.candidate().unwrap()["ng_words"],
            json!(["  雀魂 NG  ", "ID"])
        );
        assert!(form.dirty());
        form.reset(&snapshot);
        assert_eq!(form.candidate().unwrap()["ng_words"], json!(["保存済み"]));
        assert!(!form.dirty());
    }

    #[test]
    fn launcher_modes_keep_hidden_edits_and_failed_save_drafts() {
        let original = saved();
        let mut form = Form::new();
        form.refresh(&original);
        for mode in ["default", "browser", "application"] {
            form.update(Message::Input(Field::LauncherMode, mode.into()));
            form.update(Message::Input(
                Field::LauncherPath,
                "/path with spaces/app".into(),
            ));
            form.update(Message::Input(Field::LauncherProfile, "Profile 2".into()));
            form.update(Message::Input(
                Field::LauncherUserDataDir,
                "/data with spaces".into(),
            ));
            let candidate = form.candidate().unwrap();
            assert_eq!(candidate["launcher_mode"], mode);
            assert_eq!(candidate["launcher_path"], "/path with spaces/app");
            assert_eq!(candidate["launcher_profile"], "Profile 2");
            assert_eq!(candidate["launcher_user_data_dir"], "/data with spaces");
            assert_eq!(candidate["future"], original["future"]);
            form.refresh(&original);
            assert_eq!(form.candidate().unwrap(), candidate);
        }
    }

    #[test]
    fn launcher_arguments_keep_spaces_and_separate_lines_across_failed_save() {
        let mut original = saved();
        original["launcher_args"] = json!([]);
        let mut form = Form::new();
        form.refresh(&original);
        form.update(Message::List(
            Field::LauncherArgs,
            text_editor::Action::Edit(text_editor::Edit::Paste(std::sync::Arc::new(
                "-applaunch\n12345\n  one argument with spaces  \r\n\n".into(),
            ))),
        ));
        let candidate = form.candidate().unwrap();
        assert_eq!(
            candidate["launcher_args"],
            json!(["-applaunch", "12345", "  one argument with spaces  "])
        );
        form.update(Message::Input(Field::LauncherMode, "default".into()));
        form.refresh(&original);
        assert_eq!(
            form.candidate().unwrap()["launcher_args"],
            candidate["launcher_args"]
        );
        form.reset(&original);
        assert!(!form.dirty());
    }
}
