#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

mod appearance;
mod desktop;
mod model;
mod notifications;
mod settings;
mod worker;

use iced::{
    widget::{button, column, container, horizontal_rule, row, scrollable, text, toggler},
    Element, Font, Length, Subscription, Task,
};
use model::Snapshot;
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{mpsc::TryRecvError, Arc},
    time::{Duration, Instant},
};
use worker::{Command, Event, Worker};

const PAGE_BODY_ID: &str = "page-body";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(directory) = data_directory()? else {
        return Ok(());
    };
    eprintln!("sureneco-iced data directory: {}", directory.display());
    iced::application("スレネコチェッカー", App::update, App::view)
        .subscription(App::subscription)
        .theme(|_| appearance::theme())
        .default_font(japanese_font())
        .window(iced::window::Settings {
            size: iced::Size::new(1120.0, 820.0),
            min_size: Some(iced::Size::new(400.0, 600.0)),
            exit_on_close_request: false,
            ..Default::default()
        })
        .run_with(move || (App::new(directory), Task::none()))?;
    Ok(())
}

fn japanese_font() -> Font {
    // Advanced shaping below enables cosmic-text's installed system-font fallback.
    // Do not bundle an unlicensed font or rely on Iced's optional Latin-only font.
    #[cfg(target_os = "windows")]
    let family = "Yu Gothic UI";
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Page {
    Threads,
    Recruitments,
    Settings,
}

#[derive(Debug, Clone)]
enum Message {
    Tick,
    Refresh,
    Watch(String, bool),
    Open(String, Option<u64>),
    Copy(String),
    SelectPage(Page),
    ToggleDetails,
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
    page: Page,
    show_details: bool,
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
            page: Page::Threads,
            show_details: false,
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
            Message::SelectPage(page) if !self.closing => {
                self.page = page;
                return scrollable::snap_to(
                    scrollable::Id::new(PAGE_BODY_ID),
                    scrollable::RelativeOffset::START,
                );
            }
            Message::ToggleDetails if !self.closing => self.show_details = !self.show_details,
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
            | Message::SelectPage(_)
            | Message::ToggleDetails
            | Message::SaveSettings
            | Message::ResetSettings
            | Message::ClearErrors => {}
        }
        Task::none()
    }

    fn view(&self) -> Element<'_, Message> {
        let available = self.available();
        let now = unix_millis();
        let (threads, watched, active) = self.snapshot.as_ref().map_or((0, 0, 0), |snapshot| {
            let emphasis = recruitment_emphasis(snapshot);
            (
                snapshot.threads.len(),
                snapshot.watched.len(),
                snapshot
                    .recruitments
                    .iter()
                    .filter(|item| recruitment_active(item, now, emphasis))
                    .count(),
            )
        });
        let monitoring = if watched == 0 {
            "監視するスレッドを選択".to_owned()
        } else {
            format!("● {watched}スレッドを監視中")
        };
        let brand = row![
            container(label("猫").size(20).color(iced::Color::WHITE))
                .center_x(36)
                .center_y(36)
                .style(|theme| container::Style {
                    background: Some(theme.palette().primary.into()),
                    border: iced::Border {
                        radius: 10.0.into(),
                        ..Default::default()
                    },
                    ..Default::default()
                }),
            column![
                label("スレネコチェッカー").size(22),
                label(format!("友人戦するにゃ！ · {monitoring}"))
                    .size(12)
                    .style(appearance::muted),
            ]
            .spacing(3)
            .width(Length::Fill),
        ]
        .spacing(10)
        .align_y(iced::Alignment::Center);
        let nav = row![
            self.tab(Page::Threads, "スレッド", Some(threads)),
            self.tab(Page::Recruitments, "友人戦募集", Some(active)),
            self.tab(Page::Settings, "設定", None),
        ]
        .spacing(14);
        let mut content = column![brand, nav, horizontal_rule(1)].spacing(12);

        if self
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| !snapshot.notification_available)
            || self.notification_status.contains("利用できません")
        {
            content = content.push(
                container(
                    label("OS通知を利用できません。設定の「詳細」で接続情報を確認してください。")
                        .size(12),
                )
                .padding([6, 10])
                .width(Length::Fill)
                .style(appearance::closed_badge),
            );
        }
        if !self.notice.is_empty() {
            content = content.push(
                container(label(&self.notice).size(13))
                    .padding([6, 10])
                    .width(Length::Fill)
                    .style(appearance::badge),
            );
        }

        // Backend failures remain visible on every page, outside the details fold.
        let mut errors = column![].spacing(4);
        for error in &self.errors {
            errors = errors.push(label(error).size(13));
        }
        if let Some(snapshot) = &self.snapshot {
            for error in &snapshot.errors {
                errors = errors.push(label(error).size(13));
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
            let mut messages = column![scrollable(errors).height(Length::Shrink),].spacing(6);
            if !self.errors.is_empty() {
                messages = messages.push(
                    button(label("操作エラーを消す").size(12))
                        .padding([4, 8])
                        .style(appearance::secondary)
                        .on_press_maybe((!self.closing).then_some(Message::ClearErrors)),
                );
            }
            content = content.push(
                container(messages)
                    .max_height(120)
                    .padding([8, 10])
                    .width(Length::Fill)
                    .style(appearance::closed_badge),
            );
        }

        let body = if self.page == Page::Settings {
            self.settings_page(available)
        } else if let Some(snapshot) = &self.snapshot {
            match self.page {
                Page::Threads => self.threads_page(snapshot, available),
                Page::Recruitments => self.recruitments_page(snapshot, available, now),
                Page::Settings => unreachable!(),
            }
        } else {
            container(label(if self.failed {
                "起動に失敗しました。エラーを確認して再起動してください。"
            } else {
                "監視データを読み込んでいます…"
            }))
            .padding(24)
            .width(Length::Fill)
            .height(Length::Fill)
            .style(appearance::panel)
            .into()
        };
        content = content.push(body);
        let updated = self
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.updated_at)
            .map(|at| format!("最終更新 {}", human_datetime(at)))
            .unwrap_or_else(|| "未更新".to_owned());
        content = content.push(horizontal_rule(1)).push(
            row![
                column![
                    label(format!("{updated} · {}", self.operation_status()))
                        .size(11)
                        .style(appearance::muted),
                    label(if self.tray_available() {
                        "閉じるとトレイで監視を続けます。"
                    } else {
                        "トレイを利用できないため、閉じると終了します。"
                    })
                    .size(11)
                    .style(appearance::muted),
                ]
                .spacing(3)
                .width(Length::Fill),
                button(label("終了").size(12))
                    .padding([5, 12])
                    .style(appearance::secondary)
                    .on_press_maybe((!self.closing).then_some(Message::Quit)),
            ]
            .spacing(12)
            .align_y(iced::Alignment::Center),
        );
        container(
            container(content.height(Length::Fill))
                .max_width(1100)
                .height(Length::Fill)
                .padding([16, 20]),
        )
        .center_x(Length::Fill)
        .height(Length::Fill)
        .into()
    }

    fn tab<'a>(&self, page: Page, title: &'a str, count: Option<usize>) -> Element<'a, Message> {
        let mut caption = row![label(title).size(14)]
            .spacing(5)
            .align_y(iced::Alignment::Center);
        if let Some(count) = count {
            caption = caption.push(
                container(label(count.to_string()).size(11))
                    .padding([1, 6])
                    .style(appearance::badge),
            );
        }
        button(caption)
            .padding([8, 3])
            .style(if self.page == page {
                appearance::active_tab
            } else {
                appearance::tab
            })
            .on_press_maybe((!self.closing).then_some(Message::SelectPage(page)))
            .into()
    }

    fn operation_status(&self) -> String {
        if self.closing {
            "通信・保存の完了を待って終了中…".to_owned()
        } else if self.failed {
            "バックエンド停止".to_owned()
        } else if self.snapshot.is_none() {
            "起動中…".to_owned()
        } else if self.busy
            || self.pending
            || self
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.refreshing)
        {
            "更新中…".to_owned()
        } else {
            let remaining = self
                .next_poll
                .map(|at| at.saturating_duration_since(Instant::now()).as_secs())
                .unwrap_or(0);
            format!("次回確認まで {remaining} 秒 · {}秒ごと", self.interval)
        }
    }

    fn settings_page(&self, available: bool) -> Element<'_, Message> {
        let heading = column![
            label("設定").size(18),
            label("検出条件と通知の対象を調整できます。")
                .size(13)
                .style(appearance::muted),
            row![
                button(label("保存").size(13))
                    .padding([6, 14])
                    .style(appearance::primary)
                    .on_press_maybe(
                        (available && self.settings.dirty()).then_some(Message::SaveSettings)
                    ),
                button(label("保存済みに戻す").size(13))
                    .padding([6, 12])
                    .style(appearance::secondary)
                    .on_press_maybe(
                        (available && self.settings.dirty()).then_some(Message::ResetSettings)
                    ),
                label(if self.settings.dirty() {
                    "未保存の編集あり"
                } else {
                    "保存済み"
                })
                .size(12)
                .style(appearance::muted),
            ]
            .spacing(10)
            .align_y(iced::Alignment::Center),
        ]
        .spacing(6);
        let mut settings = column![
            self.settings.view(available).map(Message::Settings),
            button(
                label(if self.show_details {
                    "詳細を閉じる"
                } else {
                    "詳細 · 保存先・接続情報"
                })
                .size(13)
            )
            .padding([6, 12])
            .style(appearance::secondary)
            .on_press_maybe((!self.closing).then_some(Message::ToggleDetails)),
        ]
        .spacing(12);
        if self.show_details {
            settings = settings.push(
                container(
                    column![
                        label("Iced比較試作 · 接続情報").size(14),
                        label(format!("保存先: {}", self.directory.display())).size(12),
                        label(&self.notification_status).size(12),
                        label(&self.desktop_status).size(12),
                        label("「終了」は通信・保存の完了を待って終了します。").size(12),
                    ]
                    .spacing(8),
                )
                .padding(14)
                .width(Length::Fill)
                .style(appearance::panel),
            );
        }
        column![
            heading,
            scrollable(settings)
                .id(scrollable::Id::new(PAGE_BODY_ID))
                .height(Length::Fill)
                .width(Length::Fill),
        ]
        .spacing(12)
        .height(Length::Fill)
        .into()
    }

    fn threads_page<'a>(&self, snapshot: &'a Snapshot, available: bool) -> Element<'a, Message> {
        let refreshing = self.busy || self.pending || snapshot.refreshing;
        let heading = row![
            column![
                label("雀魂スレッド").size(18),
                label("通知を受け取りたいスレッドを選んでください。")
                    .size(13)
                    .style(appearance::muted),
            ]
            .spacing(5)
            .width(Length::Fill),
            button(
                label(if refreshing {
                    "更新中…"
                } else {
                    "今すぐ更新"
                })
                .size(13)
            )
            .padding([6, 12])
            .style(appearance::secondary)
            .on_press_maybe(available.then_some(Message::Refresh)),
        ]
        .spacing(12)
        .align_y(iced::Alignment::Center);
        let mut threads = column![].spacing(0);
        for (index, thread) in snapshot.threads.iter().enumerate() {
            if index > 0 {
                threads = threads.push(horizontal_rule(1));
            }
            let mut watch = toggler(snapshot.watched.contains(&thread.id))
                .size(22)
                .style(appearance::switch);
            if available {
                let id = thread.id.clone();
                watch = watch.on_toggle(move |enabled| Message::Watch(id.clone(), enabled));
            }
            threads = threads.push(
                container(
                    row![
                        column![
                            button(label(&thread.title).size(14).width(Length::Fill))
                                .padding(0)
                                .width(Length::Fill)
                                .style(button::text)
                                .on_press_maybe(
                                    available.then(|| Message::Open(thread.id.clone(), None))
                                ),
                            label(format!("{} レス · スレッド {}", thread.count, thread.id))
                                .size(12)
                                .style(appearance::muted),
                        ]
                        .spacing(4)
                        .width(Length::Fill),
                        watch,
                    ]
                    .spacing(14)
                    .align_y(iced::Alignment::Center),
                )
                .padding([10, 14]),
            );
        }
        let mut body = column![].spacing(12);
        if snapshot.threads.is_empty() {
            body = body.push(
                container(
                    column![
                        label("候補のスレッドがありません").size(16),
                        label("更新するか、設定の正規表現と経過日数を確認してください。")
                            .size(13)
                            .style(appearance::muted),
                    ]
                    .spacing(8),
                )
                .padding(24)
                .width(Length::Fill)
                .style(appearance::panel),
            );
        } else {
            body = body.push(
                container(threads)
                    .width(Length::Fill)
                    .style(appearance::panel),
            );
        }
        for id in &snapshot.watched {
            if !snapshot.threads.iter().any(|thread| &thread.id == id) {
                let mut watch = toggler(true).size(22).style(appearance::switch);
                if available {
                    let id = id.clone();
                    watch = watch.on_toggle(move |enabled| Message::Watch(id.clone(), enabled));
                }
                body = body.push(
                    container(
                        row![
                            column![
                                button(label(format!("スレッド {id}")).width(Length::Fill))
                                    .padding(0)
                                    .width(Length::Fill)
                                    .style(button::text)
                                    .on_press_maybe(
                                        available.then(|| Message::Open(id.clone(), None))
                                    ),
                                label("一覧にありません。監視を続けています。")
                                    .size(12)
                                    .style(appearance::muted),
                            ]
                            .spacing(4)
                            .width(Length::Fill),
                            watch,
                        ]
                        .spacing(14)
                        .align_y(iced::Alignment::Center),
                    )
                    .padding([10, 14])
                    .width(Length::Fill)
                    .style(appearance::panel),
                );
            }
        }
        body = body.push(
            container(
                label("起動時と監視をオンにしたときに、現在募集中の友人戦を確認して通知します。その後は新しい募集をお知らせします。")
                    .size(13),
            )
            .padding([8, 12])
            .width(Length::Fill)
            .style(appearance::badge),
        );
        column![
            heading,
            scrollable(body)
                .id(scrollable::Id::new(PAGE_BODY_ID))
                .height(Length::Fill)
        ]
        .spacing(12)
        .height(Length::Fill)
        .into()
    }

    fn recruitments_page<'a>(
        &self,
        snapshot: &'a Snapshot,
        available: bool,
        now: u64,
    ) -> Element<'a, Message> {
        let mut cards = column![].spacing(8);
        let emphasis = recruitment_emphasis(snapshot);
        if snapshot.recruitments.is_empty() {
            cards = cards.push(
                container(
                    column![
                        label("友人戦の募集はまだありません").size(16),
                        label("スレッドを監視すると、見つかった募集をここに表示します。")
                            .size(13)
                            .style(appearance::muted),
                    ]
                    .spacing(8),
                )
                .padding(24)
                .width(Length::Fill)
                .style(appearance::panel),
            );
        }
        for item in &snapshot.recruitments {
            let active = recruitment_active(item, now, emphasis);
            let title = snapshot
                .threads
                .iter()
                .find(|thread| thread.id == item.thread_id)
                .map(|thread| thread.title.as_str())
                .unwrap_or(&item.thread_id);
            let status = container(
                label(if item.closed {
                    "満員（〆）"
                } else if active {
                    "募集中"
                } else {
                    "期限切れ"
                })
                .size(12),
            )
            .padding([3, 8])
            .style(if item.closed {
                appearance::closed_badge
            } else if active {
                appearance::badge
            } else {
                expired_badge
            });
            let mut card = column![
                row![label(format!("レス {}", item.number)).size(14), status,]
                    .spacing(8)
                    .align_y(iced::Alignment::Center),
                label(human_datetime(item.posted_at))
                    .size(12)
                    .style(appearance::muted),
                label(&item.body).size(14).width(Length::Fill),
            ]
            .spacing(8);
            if !item.room_ids.is_empty() {
                let mut ids =
                    column![label("ルームIDをコピー").size(12).style(appearance::muted)].spacing(5);
                for id in &item.room_ids {
                    ids = ids.push(
                        button(label(format!("ID {id} をコピー")).size(13))
                            .padding([5, 10])
                            .style(appearance::secondary)
                            .on_press_maybe(available.then(|| Message::Copy(id.clone()))),
                    );
                }
                card = card.push(ids);
            }
            card = card
                .push(
                    label(format!("{} · ID:{} · {}", item.name, item.id, item.watchoi))
                        .size(12)
                        .style(appearance::muted),
                )
                .push(
                    button(
                        label(format!("{title} · 投稿を開く ↗"))
                            .size(12)
                            .width(Length::Fill),
                    )
                    .padding(0)
                    .width(Length::Fill)
                    .style(button::text)
                    .on_press_maybe(
                        available.then(|| Message::Open(item.thread_id.clone(), Some(item.number))),
                    ),
                );
            cards = cards.push(
                container(card)
                    .padding([10, 14])
                    .width(Length::Fill)
                    .style(appearance::panel),
            );
        }
        column![
            column![
                label("友人戦募集").size(18),
                label("監視開始後に見つかった募集を表示します。")
                    .size(13)
                    .style(appearance::muted),
            ]
            .spacing(5),
            scrollable(cards)
                .id(scrollable::Id::new(PAGE_BODY_ID))
                .height(Length::Fill)
                .width(Length::Fill),
        ]
        .spacing(12)
        .height(Length::Fill)
        .into()
    }
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn recruitment_emphasis(snapshot: &Snapshot) -> u64 {
    snapshot.settings["emphasis_sec"]
        .as_u64()
        .unwrap_or(0)
        .saturating_mul(1000)
}

fn recruitment_active(item: &model::Recruitment, now: u64, emphasis: u64) -> bool {
    !item.closed
        && item.effective_posted_at != 0
        && now >= item.posted_at
        && now >= item.effective_posted_at
        && now - item.effective_posted_at <= emphasis
}

fn expired_badge(_: &iced::Theme) -> container::Style {
    container::Style {
        background: Some(appearance::BG.into()),
        text_color: Some(appearance::MUTED),
        border: iced::Border {
            radius: 5.0.into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn human_datetime(millis: u64) -> String {
    // Gregorian civil date from Unix days; UTC is explicit rather than guessing
    // the desktop timezone or adding a date library for display alone.
    let seconds = millis / 1000;
    let days = (seconds / 86_400) as i64 + 719_468;
    let era = days / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + i64::from(month <= 2);
    let hour = seconds % 86_400 / 3600;
    let minute = seconds % 3600 / 60;
    let second = seconds % 60;
    format!("{year:04}/{month:02}/{day:02} {hour:02}:{minute:02}:{second:02} UTC")
}

fn label<'a>(value: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(value)
        .shaping(text::Shaping::Advanced)
        .wrapping(text::Wrapping::WordOrGlyph)
}
