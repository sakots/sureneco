use iced::{
    widget::{column, horizontal_rule, scrollable, text_editor, text_input},
    Element, Length,
};
use serde_json::Value;

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
}

impl Field {
    const ALL: [Self; 13] = [
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
            Self::NgWords | Self::NgIds | Self::NgWatchois | Self::AllowedWatchois
        )
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
            value.as_str().unwrap_or_default().to_owned()
        };
        if self.field.list() {
            self.list = Some(text_editor::Content::with_text(&self.text));
        }
        self.dirty = false;
    }
}

pub struct Form {
    original: Value,
    fields: [Draft; 13],
}

impl Form {
    pub fn new() -> Self {
        Self {
            original: Value::Null,
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
        self.original = settings.clone();
        for draft in &mut self.fields {
            if !draft.dirty {
                draft.load(settings);
            }
        }
    }

    // Called only for explicit reset or an acknowledged successful settings save.
    pub fn reset(&mut self, settings: &Value) {
        self.original = settings.clone();
        for draft in &mut self.fields {
            draft.load(settings);
        }
    }

    pub fn dirty(&self) -> bool {
        self.fields.iter().any(|draft| draft.dirty)
    }

    pub fn update(&mut self, message: Message) {
        match message {
            Message::Input(field, value) => {
                if let Some(draft) = self
                    .fields
                    .iter_mut()
                    .find(|draft| draft.field == field && !field.list())
                {
                    draft.text = value;
                    draft.dirty = true;
                }
            }
            Message::List(field, action) => {
                if let Some(draft) = self.fields.iter_mut().find(|draft| draft.field == field) {
                    if let Some(content) = &mut draft.list {
                        if matches!(&action, text_editor::Action::Edit(_)) {
                            draft.dirty = true;
                        }
                        content.perform(action);
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

    pub fn view(&self, enabled: bool) -> Element<'_, Message> {
        let mut fields = column![
            crate::label("値・正規表現・URLの最終検証は既存の共通コアが行います。").size(13),
            crate::label("更新間隔は20秒以上、日数・有効期間は1以上（上限2147483）。").size(12),
            crate::label("NG／許可リスト: 空行は無視。入力中の前後の空白は保持し、保存時に共通コアが空白除去・重複整理を行います。").size(12),
            crate::label("launcher_* の設定は保持します。この試作にはランチャー操作・自動起動・自動更新はありません。").size(12),
        ].spacing(10);
        for draft in &self.fields {
            if matches!(
                draft.field,
                Field::UpdateSec | Field::ThreadTitleRegex | Field::Url | Field::NgWords
            ) {
                fields = fields.push(horizontal_rule(1));
            }
            fields = fields.push(crate::label(draft.field.label()).size(14));
            if let Some(content) = &draft.list {
                let mut editor = text_editor(content).height(100).size(15);
                if enabled {
                    let field = draft.field;
                    editor = editor.on_action(move |action| Message::List(field, action));
                }
                fields = fields.push(editor);
            } else {
                let mut input = text_input("", &draft.text).size(15).padding(8);
                if enabled {
                    let field = draft.field;
                    input = input.on_input(move |value| Message::Input(field, value));
                }
                fields = fields.push(input);
            }
        }
        scrollable(fields.padding(4)).height(Length::Fill).into()
    }
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
}
