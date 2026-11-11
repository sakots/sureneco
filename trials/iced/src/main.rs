mod desktop;
mod model;
mod notifications;
mod settings;
mod worker;

use iced::{
    widget::{button, column, container, horizontal_rule, row, scrollable, text},
    Element, Font, Length, Subscription, Task, Theme,
};
use model::Snapshot;
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{mpsc::TryRecvError, Arc},
    time::{Duration, Instant},
};
use worker::{Command, Event, Worker};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(directory) = data_directory()? else {
        return Ok(());
    };
    eprintln!("sureneco-iced data directory: {}", directory.display());
    iced::application("すれねこ · Iced比較試作", App::update, App::view)
        .subscription(App::subscription)
        .theme(|_| Theme::Light)
        .default_font(japanese_font())
        .window_size((1120.0, 820.0))
        .exit_on_close_request(false)
        .run_with(move || (App::new(directory), Task::none()))?;
    Ok(())
}

fn japanese_font() -> Font {
    // Advanced shaping below enables cosmic-text's installed system-font fallback.
    // Do not bundle an unlicensed font or rely on Iced's optional Latin-only font.
    #[cfg(target_os = "windows")]
    let family = "Yu Gothic";
    #[cfg(target_os = "macos")]
    let family = "Hiragino Sans";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let family = "Noto Sans CJK JP";
    Font::with_name(family)
}

fn data_directory() -> Result<Option<PathBuf>, Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let mut directory = None;
    while let Some(arg) = args.next() {
        if arg == "--help" || arg == "-h" {
            println!("sureneco-iced [--data-dir ABSOLUTE_DIRECTORY]\nDefault: system config directory/sureneco-iced\nNo production configuration imports or migrations. Closing hides only when a tray host is available; Quit always exits.");
            return Ok(None);
        }
        if arg != "--data-dir" || directory.is_some() {
            return Err(format!("未対応または重複した引数: {}", arg.to_string_lossy()).into());
        }
        let path = PathBuf::from(
            args.next()
                .ok_or("--data-dir に絶対パスを指定してください。")?,
        );
        if !path.is_absolute() {
            return Err("--data-dir は絶対パスで指定してください。".into());
        }
        directory = Some(path);
    }
    let directory = directory
        .or_else(|| dirs::config_dir().map(|path| path.join("sureneco-iced")))
        .ok_or("試作専用の設定ディレクトリーを取得できません。--data-dir を指定してください。")?;
    Ok(Some(directory))
}

#[derive(Debug, Clone)]
enum Message {
    Tick,
    Refresh,
    Watch(String, bool),
    Open(String, Option<u64>),
    Copy(String),
    ToggleSettings,
    Settings(settings::Message),
    SaveSettings,
    ResetSettings,
    ClearErrors,
    Close,
    Quit,
    Joined(Result<(), String>),
}

struct App {
    worker: Option<Worker>,
    snapshot: Option<Arc<Snapshot>>,
    directory: PathBuf,
    settings: settings::Form,
    desktop: Option<desktop::Desktop>,
    desktop_status: String,
    hidden: bool,
    show_settings: bool,
    busy: bool,
    pending: bool,
    failed: bool,
    closing: bool,
    errors: VecDeque<String>,
    notice: String,
    notification_status: String,
    next_poll: Option<Instant>,
    interval: u64,
}

impl App {
    fn new(directory: PathBuf) -> Self {
        let started = Worker::start(directory.clone());
        let mut errors = VecDeque::new();
        let (worker, failed) = match started {
            Ok(worker) => (Some(worker), false),
            Err(error) => {
                errors.push_back(error);
                (None, true)
            }
        };
        // Native tray resources stay on the Iced/main thread, never the worker.
        let (desktop, desktop_status) = match desktop::Desktop::new() {
            Ok(desktop) => {
                let status = desktop.status().to_owned();
                (Some(desktop), status)
            }
            Err(error) => {
                errors.push_back(error.clone());
                (None, format!("トレイ: 利用不可 · {error}"))
            }
        };
        Self {
            worker,
            snapshot: None,
            directory,
            settings: settings::Form::new(),
            desktop,
            desktop_status,
            hidden: false,
            show_settings: false,
            busy: !failed,
            pending: false,
            failed,
            closing: false,
            errors,
            notice: String::new(),
            notification_status: "OS通知: 接続確認中".into(),
            next_poll: None,
            interval: 0,
        }
    }

    fn subscription(&self) -> Subscription<Message> {
        Subscription::batch([
            iced::time::every(Duration::from_millis(250)).map(|_| Message::Tick),
            iced::event::listen_with(|event, _, _| match event {
                iced::Event::Window(iced::window::Event::CloseRequested) => Some(Message::Close),
                _ => None,
            }),
        ])
    }

    fn available(&self) -> bool {
        self.snapshot.is_some() && !self.busy && !self.pending && !self.failed && !self.closing
    }

    fn error(&mut self, error: String) {
        eprintln!("sureneco-iced: {error}");
        if self.errors.back() == Some(&error) {
            return;
        }
        if self.errors.len() == 20 {
            self.errors.pop_front();
        }
        self.errors.push_back(error);
    }

    fn dispatch(&mut self, command: Command) {
        if !self.available() {
            return;
        }
        let result = self
            .worker
            .as_ref()
            .ok_or_else(|| "バックエンドがありません。".into())
            .and_then(|worker| worker.send(command));
        match result {
            Ok(()) => {
                self.pending = true;
                self.notice.clear();
            }
            Err(error) => self.error(error),
        }
    }

    fn reset_settings(&mut self) {
        if let Some(snapshot) = &self.snapshot {
            self.settings.reset(&snapshot.settings);
        }
    }

    fn poll(&mut self) {
        loop {
            let event = match self.worker.as_ref() {
                Some(worker) => worker.events.try_recv(),
                None => break,
            };
            match event {
                Ok(Event::Snapshot(snapshot)) => {
                    let settings_changed = self
                        .snapshot
                        .as_ref()
                        .is_none_or(|previous| previous.settings != snapshot.settings);
                    self.snapshot = Some(snapshot);
                    if settings_changed {
                        if let Some(snapshot) = &self.snapshot {
                            self.settings.refresh(&snapshot.settings);
                        }
                    }
                }
                Ok(Event::Busy(busy)) => self.busy = busy,
                Ok(Event::Scheduled { at, seconds }) => {
                    self.next_poll = Some(at);
                    self.interval = seconds;
                }
                Ok(Event::NotificationStatus(status)) => self.notification_status = status,
                Ok(Event::Completed {
                    settings_saved,
                    result,
                }) => {
                    self.pending = false;
                    match result {
                        Ok(message) => {
                            self.notice = message;
                            if settings_saved {
                                self.reset_settings();
                            }
                        }
                        Err(error) => self.error(error),
                    }
                }
                Ok(Event::Fatal(error)) => {
                    self.failed = true;
                    self.busy = false;
                    self.error(error);
                }
                Ok(Event::Error(error)) => self.error(error),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    if !self.closing && !self.failed {
                        self.failed = true;
                        self.busy = false;
                        self.error(
                            "バックエンドが予期せず終了しました。アプリを再起動してください。"
                                .into(),
                        );
                    }
                    break;
                }
            }
        }
    }

    fn tray_available(&self) -> bool {
        self.desktop
            .as_ref()
            .is_some_and(desktop::Desktop::available)
    }

    fn show_window(&mut self) -> Task<Message> {
        self.hidden = false;
        iced::window::get_latest().and_then(|id| {
            iced::window::change_mode(id, iced::window::Mode::Windowed)
                .chain(iced::window::minimize(id, false))
                .chain(iced::window::gain_focus(id))
        })
    }

    fn quit(&mut self) -> Task<Message> {
        if self.closing {
            return Task::none();
        }
        self.closing = true;
        if let Some(join) = self.worker.as_mut().and_then(Worker::shutdown) {
            return Task::perform(
                async move {
                    tokio::task::spawn_blocking(move || {
                        join.join()
                            .map_err(|_| "バックエンドスレッドが異常終了しました。".to_owned())
                    })
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(|result| result)
                },
                Message::Joined,
            );
        }
        iced::exit()
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Tick => {
                self.poll();
                let mut task = Task::none();
                loop {
                    let action = self.desktop.as_mut().and_then(desktop::Desktop::poll);
                    match action {
                        Some(desktop::Action::Show) if !self.closing => {
                            task = task.chain(self.show_window());
                        }
                        Some(desktop::Action::Refresh) => self.dispatch(Command::Refresh),
                        Some(desktop::Action::Quit) => return self.quit(),
                        Some(desktop::Action::Show) => {}
                        None => break,
                    }
                }
                if let Some(desktop) = &self.desktop {
                    let status = desktop.status();
                    if status != self.desktop_status {
                        self.desktop_status = status.to_owned();
                    }
                }
                // A lost tray must not strand the only window out of reach.
                if self.hidden && !self.tray_available() && !self.closing {
                    task = task.chain(self.show_window());
                }
                return task;
            }
            Message::Refresh => self.dispatch(Command::Refresh),
            Message::Watch(id, enabled) => self.dispatch(Command::Watch { id, enabled }),
            Message::Open(id, post) => self.dispatch(Command::Open { id, post }),
            Message::Copy(id) => self.dispatch(Command::Copy(id)),
            Message::ToggleSettings if !self.closing => self.show_settings = !self.show_settings,
            Message::Settings(message) => {
                if self.available() {
                    self.settings.update(message);
                }
            }
            Message::SaveSettings if self.available() && self.settings.dirty() => {
                match self.settings.candidate() {
                    Ok(settings) => self.dispatch(Command::Settings(settings)),
                    Err(error) => self.error(error),
                }
            }
            Message::ResetSettings if self.available() => self.reset_settings(),
            Message::ClearErrors if !self.closing => self.errors.clear(),
            Message::Close if !self.closing => {
                if self.tray_available() {
                    self.hidden = true;
                    return iced::window::get_latest()
                        .and_then(|id| iced::window::change_mode(id, iced::window::Mode::Hidden));
                }
                return self.quit();
            }
            Message::Quit => return self.quit(),
            Message::Joined(result) => {
                if let Err(error) = result {
                    eprintln!("sureneco-iced shutdown: {error}");
                }
                return iced::exit();
            }
            Message::Close
            | Message::ToggleSettings
            | Message::SaveSettings
            | Message::ResetSettings
            | Message::ClearErrors => {}
        }
        Task::none()
    }

    fn view(&self) -> Element<'_, Message> {
        let available = self.available();
        let status = if self.closing {
            "終了処理中 (現在の通信・保存の完了を待っています)".to_owned()
        } else if self.failed {
            "バックエンド停止: 下のエラーを確認してください。".to_owned()
        } else if self.snapshot.is_none() {
            "バックエンドを起動中…".to_owned()
        } else if self.busy
            || self.pending
            || self
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.refreshing)
        {
            "処理中… (専用ワーカースレッド)".to_owned()
        } else {
            let remaining = self
                .next_poll
                .map(|at| at.saturating_duration_since(Instant::now()).as_secs())
                .unwrap_or(0);
            format!(
                "待機中 · 次回の定期確認まで {remaining} 秒 / 間隔 {} 秒",
                self.interval
            )
        };
        let mut content = column![
            row![
                label("すれねこ · Iced比較試作")
                    .size(24)
                    .width(Length::Fill),
                button(label("手動更新")).on_press_maybe(available.then_some(Message::Refresh)),
                button(label(if self.show_settings {
                    "一覧に戻る"
                } else {
                    "設定"
                }))
                .on_press_maybe((!self.closing).then_some(Message::ToggleSettings)),
                button(label("終了")).on_press_maybe((!self.closing).then_some(Message::Quit)),
            ]
            .spacing(12),
            label(status).size(14),
            label(format!("保存先: {}", self.directory.display())).size(12),
            label(&self.notification_status).size(12),
            label(&self.desktop_status).size(12),
            label(if self.tray_available() {
                "閉じるとトレイで監視を続けます。「終了」は通信・保存の完了を待って終了します。"
            } else {
                "トレイを利用できないため、閉じると通信・保存の完了を待って終了します。"
            })
            .size(12),
            horizontal_rule(1),
        ]
        .spacing(8)
        .padding(16);

        let body: Element<'_, Message> = if self.show_settings {
            column![
                label("設定").size(18),
                row![
                    button(label("検証して保存")).on_press_maybe(
                        (available && self.settings.dirty()).then_some(Message::SaveSettings)
                    ),
                    button(label("保存済みに戻す")).on_press_maybe(
                        (available && self.settings.dirty()).then_some(Message::ResetSettings)
                    ),
                    label(if self.settings.dirty() {
                        "未保存の編集あり"
                    } else {
                        "保存済みの設定"
                    }),
                ]
                .spacing(12),
                self.settings.view(available).map(Message::Settings),
            ]
            .spacing(10)
            .height(Length::Fill)
            .into()
        } else if let Some(snapshot) = &self.snapshot {
            self.lists(snapshot, available)
        } else {
            container(label(if self.failed {
                "起動に失敗しました。エラーを確認して再起動してください。"
            } else {
                "監視コアと保存データを読み込んでいます…"
            }))
            .height(Length::Fill)
            .into()
        };
        content = content.push(body);
        if !self.notice.is_empty() {
            content = content.push(label(&self.notice).size(13));
        }

        let mut errors = column![].spacing(4);
        for error in &self.errors {
            errors = errors.push(label(error).size(13).style(text::danger));
        }
        if let Some(snapshot) = &self.snapshot {
            for error in &snapshot.errors {
                errors = errors.push(label(error).size(13).style(text::danger));
            }
            for notice in &snapshot.notices {
                errors = errors.push(label(notice).size(13));
            }
        }
        if !self.errors.is_empty()
            || self
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| !snapshot.errors.is_empty() || !snapshot.notices.is_empty())
        {
            content = content.push(
                row![
                    scrollable(errors).height(100).width(Length::Fill),
                    button(label("操作エラーを消す"))
                        .on_press_maybe((!self.closing).then_some(Message::ClearErrors)),
                ]
                .spacing(10),
            );
        }
        content.height(Length::Fill).into()
    }

    fn lists<'a>(&self, snapshot: &'a Snapshot, available: bool) -> Element<'a, Message> {
        let mut threads =
            column![label(format!("スレッド候補 ({})", snapshot.threads.len())).size(18)]
                .spacing(12);
        if snapshot.threads.is_empty() {
            threads = threads.push(label(
                "候補はありません。設定と通信エラーを確認してください。",
            ));
        }
        for thread in &snapshot.threads {
            let watched = snapshot.watched.contains(&thread.id);
            threads = threads.push(
                container(
                    column![
                        label(&thread.title).size(16),
                        label(format!("{} · {} レス", thread.id, thread.count)).size(12),
                        row![
                            button(label(if watched {
                                "監視中 · 解除"
                            } else {
                                "監視する"
                            }))
                            .on_press_maybe(
                                available.then(|| Message::Watch(thread.id.clone(), !watched))
                            ),
                            button(label("開く")).on_press_maybe(
                                available.then(|| Message::Open(thread.id.clone(), None))
                            ),
                        ]
                        .spacing(8),
                    ]
                    .spacing(6),
                )
                .padding(10)
                .style(container::rounded_box),
            );
        }
        for id in &snapshot.watched {
            if !snapshot.threads.iter().any(|thread| &thread.id == id) {
                threads = threads.push(
                    row![
                        label(format!("一覧外の監視: {id}")).width(Length::Fill),
                        button(label("解除"))
                            .on_press_maybe(available.then(|| Message::Watch(id.clone(), false))),
                    ]
                    .spacing(8),
                );
            }
        }
        let mut recruitments =
            column![label(format!("友人戦募集 ({})", snapshot.recruitments.len())).size(18)]
                .spacing(12);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let emphasis = snapshot.settings["emphasis_sec"]
            .as_u64()
            .unwrap_or(0)
            .saturating_mul(1000);
        if snapshot.recruitments.is_empty() {
            recruitments = recruitments.push(label(
                "募集はありません。スレッドを監視するとここに表示します。",
            ));
        }
        for item in &snapshot.recruitments {
            let title = snapshot
                .threads
                .iter()
                .find(|thread| thread.id == item.thread_id)
                .map(|thread| thread.title.as_str())
                .unwrap_or(&item.thread_id);
            let mut ids = row![].spacing(8);
            for id in &item.room_ids {
                ids = ids.push(
                    button(label(format!("ID {id} をコピー")))
                        .on_press_maybe(available.then(|| Message::Copy(id.clone()))),
                );
            }
            recruitments = recruitments.push(
                container(
                    column![
                        row![
                            label(if item.closed {
                                "締め切り"
                            } else if item.effective_posted_at == 0
                                || now < item.posted_at
                                || now < item.effective_posted_at
                                || now - item.effective_posted_at > emphasis
                            {
                                "期限切れ"
                            } else {
                                "募集中"
                            })
                            .size(16),
                            label(format!("#{number} · {title}", number = item.number))
                                .width(Length::Fill)
                                .size(13),
                            button(label("投稿を開く")).on_press_maybe(available.then(|| {
                                Message::Open(item.thread_id.clone(), Some(item.number))
                            })),
                        ]
                        .spacing(8),
                        label(format!("{} · ID:{} · {}", item.name, item.id, item.watchoi))
                            .size(12),
                        label(format!("投稿時刻 (Unix秒): {}", item.posted_at / 1000)).size(12),
                        label(&item.body).size(15),
                        ids,
                    ]
                    .spacing(8),
                )
                .padding(12)
                .style(container::rounded_box),
            );
        }
        let updated = snapshot
            .updated_at
            .map(|time| format!("最終更新 (Unix秒): {}", time / 1000))
            .unwrap_or_else(|| "未更新".into());
        column![
            label(format!(
                "{updated} · 監視 {} 件 · OS通知 {}",
                snapshot.watched.len(),
                if snapshot.notification_available {
                    "利用可能"
                } else {
                    "利用不可"
                }
            ))
            .size(12),
            row![
                scrollable(threads)
                    .height(Length::Fill)
                    .width(Length::FillPortion(2)),
                scrollable(recruitments)
                    .height(Length::Fill)
                    .width(Length::FillPortion(3)),
            ]
            .spacing(16)
            .height(Length::Fill),
        ]
        .spacing(10)
        .height(Length::Fill)
        .into()
    }
}

fn label<'a>(value: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(value).shaping(text::Shaping::Advanced)
}
