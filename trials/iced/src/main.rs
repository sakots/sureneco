#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

mod appearance;
mod config_storage;
mod desktop;
mod model;
mod notifications;
mod settings;
mod single_instance;
mod ui_preferences;
mod window_state;
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
    let Some(_instance) = single_instance::acquire(&directory)
        .map_err(|error| format!("多重起動防止ロックを取得できません: {error}"))?
    else {
        eprintln!("同じ設定フォルダーのIced版は既に起動しています。");
        return Ok(());
    };
    let Some(storage) = config_storage::Storage::load(directory.clone())? else {
        eprintln!("設定保存先は他のIced版が使用中です。");
        return Ok(());
    };
    eprintln!("sureneco-iced data directory: {}", directory.display());
    let (geometry, geometry_error) = match window_state::load(&directory) {
        Ok(state) => (state.unwrap_or_default(), None),
        Err(error) => (window_state::Geometry::default(), Some(error)),
    };
    let mut window = geometry.settings();
    window.icon = Some(iced::window::icon::from_rgba(
        include_bytes!("../assets/icons/app.rgba").to_vec(),
        256,
        256,
    )?);
    iced::application("スレネコチェッカー", App::update, App::view)
        .subscription(App::subscription)
        .theme(|app: &App| appearance::theme(app.preferences.dark_mode))
        .settings(iced::Settings {
            default_text_size: iced::Pixels(14.0),
            ..Default::default()
        })
        .font(include_bytes!("../assets/fonts/NotoSansJP-Medium.otf").as_slice())
        .default_font(Font {
            weight: iced::font::Weight::Medium,
            ..Font::with_name("Noto Sans JP")
        })
        .window(window)
        .run_with(move || {
            (
                App::new(directory, storage, geometry, geometry_error),
                Task::none(),
            )
        })?;
    Ok(())
}

fn data_directory() -> Result<Option<PathBuf>, Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let mut directory = None;
    while let Some(arg) = args.next() {
        if arg == "--help" || arg == "-h" {
            println!("sureneco-iced [--data-dir ABSOLUTE_DIRECTORY]\n--data-dir: Icedの起動基準フォルダー（既定: OS設定フォルダー/sureneco-iced）。\n設定データの保存先は画面から変更でき、基準内のconfig-location.jsonで次回も復元します。\n外観・ウィンドウ状態は基準に保持します。本番設定の自動コピー・移行は行いません。\nトレイ利用時は閉じても常駐し、「終了」で終了します。");
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
    Launch(String),
    SelectPage(Page),
    ToggleDetails,
    DarkMode(bool),
    DirectoryInput(String),
    ChangeDirectory,
    RestoreDirectory,
    Settings(settings::Message),
    SaveSettings,
    RestoreDefaults(settings::Section),
    ClearErrors,
    Close,
    Quit,
    Joined(Result<(), String>),
    Window(iced::window::Id, iced::window::Event),
    WindowSample(u64, WindowSample),
}

#[derive(Debug, Clone)]
struct WindowSample {
    maximized: bool,
    minimized: Option<bool>,
    mode: iced::window::Mode,
    position: Result<Option<iced::Point>, String>,
    size: iced::Size,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WindowAction {
    Hide,
    Quit,
}

struct App {
    worker: Option<Worker>,
    snapshot: Option<Arc<Snapshot>>,
    directory: PathBuf,
    config_directory: PathBuf,
    directory_input: String,
    settings: settings::Form,
    default_settings: Option<serde_json::Value>,
    preferences: ui_preferences::Preferences,
    desktop: Option<desktop::Desktop>,
    desktop_status: String,
    hidden: bool,
    geometry: window_state::Geometry,
    geometry_dirty: bool,
    geometry_changed_at: Option<Instant>,
    geometry_generation: u64,
    geometry_query: Option<u64>,
    window_id: Option<iced::window::Id>,
    geometry_last_query: Instant,
    restoring_maximized: bool,
    window_action: Option<WindowAction>,
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
    fn new(
        directory: PathBuf,
        storage: config_storage::Storage,
        geometry: window_state::Geometry,
        geometry_error: Option<String>,
    ) -> Self {
        let config_directory = storage.directory().to_path_buf();
        let directory_input = config_directory.to_string_lossy().into_owned();
        let started = Worker::start(storage);
        let mut errors = VecDeque::new();
        if let Some(error) = geometry_error {
            errors.push_back(error);
        }
        let preferences = match ui_preferences::Preferences::load(&directory) {
            Ok(preferences) => preferences,
            Err(error) => {
                errors.push_back(error);
                ui_preferences::Preferences::default()
            }
        };
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
            config_directory,
            directory_input,
            settings: settings::Form::new(),
            default_settings: None,
            preferences,
            desktop,
            desktop_status,
            hidden: false,
            geometry,
            geometry_dirty: true,
            geometry_changed_at: None,
            geometry_generation: 0,
            geometry_query: None,
            window_id: None,
            geometry_last_query: Instant::now(),
            restoring_maximized: geometry.maximized,
            window_action: None,
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
            iced::event::listen_with(|event, _, id| match event {
                iced::Event::Window(
                    event @ (iced::window::Event::Opened { .. }
                    | iced::window::Event::Moved(_)
                    | iced::window::Event::Resized(_)
                    | iced::window::Event::Focused
                    | iced::window::Event::Unfocused),
                ) => Some(Message::Window(id, event)),
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
                Ok(Event::DefaultSettings(settings)) => self.default_settings = Some(settings),
                Ok(Event::ConfigDirectory(directory)) => {
                    self.directory_input = directory.to_string_lossy().into_owned();
                    self.config_directory = directory;
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

    fn geometry_changed(&mut self) {
        self.geometry_generation = self.geometry_generation.wrapping_add(1);
        self.geometry_changed_at = Some(Instant::now());
    }

    fn sample_window(&mut self) -> Task<Message> {
        let Some(id) = self.window_id else {
            return Task::none();
        };
        let generation = self.geometry_generation;
        self.geometry_last_query = Instant::now();
        self.geometry_query = Some(generation);
        // Query native state, not event dimensions: a resize can belong to a
        // maximize/minimize transition. The generation rejects interrupted samples.
        iced::window::get_maximized(id).then(move |maximized| {
            iced::window::get_minimized(id).then(move |minimized| {
                iced::window::get_mode(id).then(move |mode| {
                    iced::window::get_scale_factor(id).then(move |scale| {
                        iced::window::get_size(id).then(move |size| {
                            iced::window::run_with_handle(id, move |handle| {
                                native_window_position(handle.as_raw()).map(|position| {
                                    position.map(|(x, y)| iced::Point::new(x / scale, y / scale))
                                })
                            })
                            .map(move |position| {
                                Message::WindowSample(
                                    generation,
                                    WindowSample {
                                        maximized,
                                        minimized,
                                        mode,
                                        position,
                                        size,
                                    },
                                )
                            })
                        })
                    })
                })
            })
        })
    }

    fn accept_window_sample(&mut self, sample: WindowSample) {
        if self.hidden
            || sample.minimized == Some(true)
            || sample.mode != iced::window::Mode::Windowed
        {
            return;
        }
        // Do not replace the saved normal rectangle with startup maximize events.
        // set_maximized is asynchronous at the OS level.
        if self.restoring_maximized {
            if !sample.maximized {
                return;
            }
            self.restoring_maximized = false;
        }
        let mut geometry = self.geometry;
        geometry.maximized = sample.maximized;
        if !sample.maximized
            && sample.size.width.is_finite()
            && sample.size.height.is_finite()
            && sample.size.width >= 400.0
            && sample.size.height >= 600.0
        {
            geometry.width = sample.size.width;
            geometry.height = sample.size.height;
            // Wayland has no window position; size remains independently useful.
            match sample.position {
                Ok(Some(position)) if position.x.is_finite() && position.y.is_finite() => {
                    geometry.x = Some(position.x);
                    geometry.y = Some(position.y);
                }
                Ok(None) => {
                    geometry.x = None;
                    geometry.y = None;
                }
                Ok(Some(_)) => {}
                Err(error) => self.error(error),
            }
        }
        if geometry != self.geometry {
            self.geometry = geometry;
            self.geometry_dirty = true;
            self.geometry_changed_at.get_or_insert_with(Instant::now);
        }
    }

    fn flush_geometry(&mut self) {
        if !self.geometry_dirty {
            return;
        }
        // A failed save is reported once, not retried on every 250ms UI tick.
        // Another change or an explicit close/quit provides a retry opportunity.
        match window_state::save(&self.directory, &self.geometry) {
            Ok(()) => self.geometry_dirty = false,
            Err(error) => self.error(error),
        }
    }

    fn show_window(&mut self) -> Task<Message> {
        if self.window_action.is_some() {
            return Task::none();
        }
        let was_hidden = self.hidden;
        self.hidden = false;
        self.geometry_changed();
        if was_hidden {
            self.restoring_maximized = self.geometry.maximized;
        }
        let maximized = self.geometry.maximized;
        iced::window::get_latest().and_then(move |id| {
            let show = iced::window::change_mode(id, iced::window::Mode::Windowed)
                .chain(iced::window::minimize(id, false));
            let show = if was_hidden {
                show.chain(iced::window::maximize(id, maximized))
            } else {
                show
            };
            show.chain(iced::window::gain_focus(id))
        })
    }

    fn request_window_action(&mut self, action: WindowAction) -> Task<Message> {
        if self.closing {
            return Task::none();
        }
        // Quit supersedes an in-flight close-to-tray request.
        if self.window_action == Some(WindowAction::Quit) {
            return Task::none();
        }
        self.window_action = Some(action);
        self.geometry_changed();
        if !self.hidden && self.window_id.is_some() {
            return self.sample_window();
        }
        self.finish_window_action()
    }

    fn finish_window_action(&mut self) -> Task<Message> {
        self.geometry_changed_at = None;
        self.flush_geometry();
        match self.window_action.take() {
            Some(WindowAction::Hide) if self.tray_available() => {
                self.hidden = true;
                iced::window::get_latest()
                    .and_then(|id| iced::window::change_mode(id, iced::window::Mode::Hidden))
            }
            Some(_) => self.finish_quit(),
            None => Task::none(),
        }
    }

    fn quit(&mut self) -> Task<Message> {
        self.request_window_action(WindowAction::Quit)
    }

    fn finish_quit(&mut self) -> Task<Message> {
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
            Message::DirectoryInput(value) => {
                if self.available() {
                    self.directory_input = value;
                    self.notice.clear();
                }
            }
            Message::ChangeDirectory => {
                self.dispatch(Command::ConfigDirectory(PathBuf::from(
                    &self.directory_input,
                )));
            }
            Message::RestoreDirectory if self.available() => {
                self.directory_input = self.directory.to_string_lossy().into_owned();
                self.notice.clear();
            }
            Message::DarkMode(dark_mode) => {
                if !self.closing && dark_mode != self.preferences.dark_mode {
                    let preferences = ui_preferences::Preferences { dark_mode };
                    match preferences.save(&self.directory) {
                        Ok(()) => self.preferences = preferences,
                        Err(error) => self.error(format!("配色を保存できません: {error}")),
                    }
                }
            }
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
                if !self.hidden
                    && !self.closing
                    && self.window_action.is_none()
                    && self.geometry_query.is_none()
                    && self
                        .geometry_changed_at
                        .is_some_and(|changed| changed.elapsed() >= Duration::from_millis(500))
                {
                    if self.restoring_maximized {
                        // Some window managers reject maximize requests. Once
                        // startup/show events settle, accept a fresh native query
                        // instead of suppressing normal geometry indefinitely.
                        self.restoring_maximized = false;
                        task = task.chain(self.sample_window());
                    } else {
                        self.geometry_changed_at = None;
                        self.flush_geometry();
                    }
                }
                // Winit can omit Moved (notably for X11 ConfigureNotify).
                // Poll native geometry at low frequency without saving unchanged
                // state or running any expensive UI/network work.
                if !self.hidden
                    && !self.closing
                    && self.window_action.is_none()
                    && self.geometry_query.is_none()
                    && self.geometry_last_query.elapsed() >= Duration::from_secs(1)
                {
                    task = task.chain(self.sample_window());
                }
                return task;
            }
            Message::Window(id, event) => {
                if self.hidden || self.closing {
                    return Task::none();
                }
                self.geometry_changed();
                if matches!(event, iced::window::Event::Opened { .. }) {
                    self.window_id = Some(id);
                    if self.restoring_maximized {
                        return iced::window::maximize(id, true);
                    }
                }
                if self.geometry_query.is_none() {
                    return self.sample_window();
                }
            }
            Message::WindowSample(generation, sample) => {
                if self.geometry_query != Some(generation) {
                    return Task::none();
                }
                self.geometry_query = None;
                if generation != self.geometry_generation {
                    if !self.hidden && !self.closing {
                        return self.sample_window();
                    }
                    return Task::none();
                }
                self.accept_window_sample(sample);
                if self.window_action.is_some() {
                    return self.finish_window_action();
                }
            }
            Message::Refresh => self.dispatch(Command::Refresh),
            Message::Watch(id, enabled) => self.dispatch(Command::Watch { id, enabled }),
            Message::Open(id, post) => self.dispatch(Command::Open { id, post }),
            Message::Copy(id) => self.dispatch(Command::Copy(id)),
            Message::Launch(id) => self.dispatch(Command::Launch(id)),
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
                    if self.settings.dirty() {
                        self.notice.clear();
                    }
                }
            }
            Message::SaveSettings if self.available() && self.settings.dirty() => {
                match self.settings.candidate() {
                    Ok(settings) => self.dispatch(Command::Settings(settings)),
                    Err(error) => self.error(error),
                }
            }
            Message::RestoreDefaults(section) if self.available() => {
                if let Some(defaults) = &self.default_settings {
                    self.settings.restore_defaults(defaults, section);
                    self.notice.clear();
                }
            }
            Message::ClearErrors if !self.closing => self.errors.clear(),
            Message::Close if !self.closing => {
                return if self.tray_available() {
                    self.request_window_action(WindowAction::Hide)
                } else {
                    self.quit()
                };
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
            | Message::RestoreDefaults(_)
            | Message::RestoreDirectory
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
            container(label("猫").size(20))
                .center_x(36)
                .center_y(36)
                .style(appearance::brand),
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
        // Keep the body at a fixed child index when status banners change.
        let mut banners = column![].spacing(12);
        let mut has_banners = false;

        if self
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| !snapshot.notification_available)
            || self.notification_status.contains("利用できません")
        {
            has_banners = true;
            banners = banners.push(
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
            has_banners = true;
            banners = banners.push(
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
            has_banners = true;
            banners = banners.push(
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
        content = content.push(
            column![banners, body]
                .spacing(if has_banners { 12 } else { 0 })
                .height(Length::Fill),
        );
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
        let dirty = self.settings.dirty();
        let mut actions = row![button(label("全体をデフォルトに戻す").size(13))
            .padding([6, 12])
            .style(appearance::secondary)
            .on_press_maybe(
                (available && self.default_settings.is_some())
                    .then_some(Message::RestoreDefaults(settings::Section::All))
            ),]
        .spacing(10)
        .align_y(iced::Alignment::Center);
        if dirty {
            actions = actions
                .push(
                    button(label("保存").size(13))
                        .padding([6, 14])
                        .style(appearance::primary)
                        .on_press_maybe(available.then_some(Message::SaveSettings)),
                )
                .push(label("未保存の変更あり").size(12).style(appearance::muted));
        }
        let heading = column![
            label("設定").size(18),
            label("検出条件・通知の対象・雀魂の起動方法を調整できます。")
                .size(13)
                .style(appearance::muted),
            actions,
            label("設定は「保存」で反映します。デフォルト復元も保存が必要です。")
                .size(12)
                .style(appearance::muted),
        ]
        .spacing(6);
        let mut dark_mode = toggler(self.preferences.dark_mode)
            .label("ダークモード")
            .size(22)
            .style(appearance::switch);
        if !self.closing {
            dark_mode = dark_mode.on_toggle(Message::DarkMode);
        }
        let appearance = container(
            column![
                label("外観").size(16),
                dark_mode,
                label("配色は自動保存され、次回起動時にも復元されます。")
                    .size(13)
                    .style(appearance::muted),
            ]
            .spacing(12),
        )
        .padding(16)
        .width(Length::Fill)
        .style(appearance::panel);
        let mut directory_input =
            iced::widget::text_input("変更先の絶対パス", &self.directory_input)
                .size(14)
                .padding(8)
                .style(appearance::input);
        if available {
            directory_input = directory_input.on_input(Message::DirectoryInput);
        }
        let config_directory = container(
            column![
                row![
                    label("設定フォルダー").size(16).width(Length::Fill),
                    button(label("デフォルトに戻す").size(13))
                        .padding([6, 12])
                        .style(appearance::secondary)
                        .on_press_maybe(available.then_some(Message::RestoreDirectory)),
                ].spacing(10).align_y(iced::Alignment::Center),
                label("現在の保存先").size(12).style(appearance::muted),
                label(self.config_directory.to_string_lossy()).size(13),
                directory_input,
                button(label("保存先を変更").size(13))
                    .padding([6, 12])
                    .style(appearance::secondary)
                    .on_press_maybe(
                        (available && !self.directory_input.is_empty()
                            && std::path::Path::new(&self.directory_input) != self.config_directory.as_path())
                            .then_some(Message::ChangeDirectory),
                    ),
                label("保存済み設定・監視対象・既読位置をコピーします。元のファイルは残し、既存のstate.jsonは上書きしません。未保存の編集は変更後に「保存」で反映できます。")
                    .size(12)
                    .style(appearance::muted),
                label("既定パスへの復元も「保存先を変更」で反映します。")
                    .size(12)
                    .style(appearance::muted),
                label("外観・ウィンドウ状態は起動基準フォルダーに残します。")
                    .size(12)
                    .style(appearance::muted),
            ]
            .spacing(10),
        )
        .padding(16)
        .width(Length::Fill)
        .style(appearance::panel);
        let mut settings = column![
            appearance,
            config_directory,
            self.settings
                .view(available, self.default_settings.is_some()),
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
                        label(format!(
                            "設定・監視データ: {}",
                            self.config_directory.display()
                        ))
                        .size(12),
                        label(format!(
                            "起動基準（外観・ウィンドウ状態）: {}",
                            self.directory.display()
                        ))
                        .size(12),
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
                    column![label("ルームID").size(12).style(appearance::muted)].spacing(5);
                for id in &item.room_ids {
                    let launch_label = if item.room_ids.len() > 1 {
                        label(format!("雀魂を起動（{id}）"))
                    } else {
                        label("雀魂を起動")
                    };
                    ids = ids.push(
                        row![
                            button(label(format!("ID {id} をコピー")).size(13))
                                .padding([5, 10])
                                .style(appearance::secondary)
                                .on_press_maybe(available.then(|| Message::Copy(id.clone()))),
                            button(launch_label.size(13))
                                .padding([5, 10])
                                .style(appearance::primary)
                                .on_press_maybe(
                                    (available && active).then(|| Message::Launch(id.clone()))
                                ),
                        ]
                        .spacing(8)
                        .wrap(),
                    );
                }
                card = card.push(ids).push(
                    label("起動時にIDをコピーします。ゲーム内の友人戦で貼り付けてください。")
                        .size(12)
                        .style(appearance::muted),
                );
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

fn expired_badge(theme: &iced::Theme) -> container::Style {
    container::Style {
        background: Some(theme.palette().background.into()),
        text_color: appearance::muted(theme).color,
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

// Iced 0.13 queries inner_position, while Settings::position is an outer
// position. Use actual native frame coordinates rather than guessing decoration
// offsets or trusting the delivery of Moved events.
fn native_window_position(
    handle: iced::window::raw_window_handle::RawWindowHandle,
) -> Result<Option<(f32, f32)>, String> {
    use iced::window::raw_window_handle::RawWindowHandle;
    #[cfg(target_os = "linux")]
    {
        let window = match handle {
            RawWindowHandle::Xlib(handle) => handle.window,
            RawWindowHandle::Xcb(handle) => std::os::raw::c_ulong::from(handle.window.get()),
            _ => return Ok(None),
        };
        return x11_position::position(window).map(Some);
    }
    #[cfg(target_os = "windows")]
    {
        if let RawWindowHandle::Win32(handle) = handle {
            use windows::Win32::{
                Foundation::{HWND, RECT},
                UI::WindowsAndMessaging::GetWindowRect,
            };
            let mut rect = RECT::default();
            // The handle belongs to the live window supplied by Iced.
            unsafe { GetWindowRect(HWND(handle.hwnd.get() as *mut std::ffi::c_void), &mut rect) }
                .map_err(|error| format!("ウィンドウ位置を取得できません: {error}"))?;
            return Ok(Some((rect.left as f32, rect.top as f32)));
        }
        Ok(None)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = handle;
        Ok(None)
    }
}

#[cfg(target_os = "linux")]
mod x11_position {
    use std::{
        cell::RefCell,
        ffi::{c_int, c_uint, c_ulong, c_void},
        ptr,
    };

    type Window = c_ulong;
    type QueryTree = unsafe extern "C" fn(
        *mut c_void,
        Window,
        *mut Window,
        *mut Window,
        *mut *mut Window,
        *mut c_uint,
    ) -> c_int;
    type GetGeometry = unsafe extern "C" fn(
        *mut c_void,
        Window,
        *mut Window,
        *mut c_int,
        *mut c_int,
        *mut c_uint,
        *mut c_uint,
        *mut c_uint,
        *mut c_uint,
    ) -> c_int;
    type Free = unsafe extern "C" fn(*mut c_void) -> c_int;
    type CloseDisplay = unsafe extern "C" fn(*mut c_void) -> c_int;

    struct Connection {
        _library: libloading::Library,
        display: *mut c_void,
        query_tree: QueryTree,
        get_geometry: GetGeometry,
        free: Free,
        close_display: CloseDisplay,
    }

    impl Connection {
        fn open() -> Result<Self, String> {
            // Resolve only the stable Xlib ABI. The library and connection are
            // retained on Iced's UI thread, never shared with worker threads.
            unsafe {
                let library =
                    libloading::Library::new("libX11.so.6").map_err(|error| error.to_string())?;
                let open = *library
                    .get::<unsafe extern "C" fn(*const i8) -> *mut c_void>(b"XOpenDisplay\0")
                    .map_err(|error| error.to_string())?;
                let query_tree = *library
                    .get::<QueryTree>(b"XQueryTree\0")
                    .map_err(|error| error.to_string())?;
                let get_geometry = *library
                    .get::<GetGeometry>(b"XGetGeometry\0")
                    .map_err(|error| error.to_string())?;
                let free = *library
                    .get::<Free>(b"XFree\0")
                    .map_err(|error| error.to_string())?;
                let close_display = *library
                    .get::<CloseDisplay>(b"XCloseDisplay\0")
                    .map_err(|error| error.to_string())?;
                let display = open(ptr::null());
                if display.is_null() {
                    return Err("X11 displayを開けません。".into());
                }
                Ok(Self {
                    _library: library,
                    display,
                    query_tree,
                    get_geometry,
                    free,
                    close_display,
                })
            }
        }

        fn position(&self, mut window: Window) -> Result<(f32, f32), String> {
            // A reparenting WM places the client inside its decoration window.
            // Walk to the frame directly below the root, then read that frame's
            // actual root-relative outer coordinates, including negative values.
            unsafe {
                loop {
                    let (mut root, mut parent, mut children, mut count) =
                        (0, 0, ptr::null_mut(), 0);
                    let result = (self.query_tree)(
                        self.display,
                        window,
                        &mut root,
                        &mut parent,
                        &mut children,
                        &mut count,
                    );
                    if !children.is_null() {
                        (self.free)(children.cast());
                    }
                    if result == 0 {
                        return Err("X11ウィンドウの親を取得できません。".into());
                    }
                    if parent == root {
                        break;
                    }
                    if parent == 0 {
                        return Err("X11ウィンドウの外枠を取得できません。".into());
                    }
                    window = parent;
                }
                let (mut root, mut x, mut y, mut width, mut height, mut border, mut depth) =
                    (0, 0, 0, 0, 0, 0, 0);
                if (self.get_geometry)(
                    self.display,
                    window,
                    &mut root,
                    &mut x,
                    &mut y,
                    &mut width,
                    &mut height,
                    &mut border,
                    &mut depth,
                ) == 0
                {
                    return Err("X11ウィンドウ位置を取得できません。".into());
                }
                Ok((x as f32, y as f32))
            }
        }
    }

    impl Drop for Connection {
        fn drop(&mut self) {
            unsafe {
                (self.close_display)(self.display);
            }
        }
    }

    thread_local! {
        static CONNECTION: RefCell<Option<Result<Connection, String>>> = const { RefCell::new(None) };
    }

    pub(super) fn position(window: Window) -> Result<(f32, f32), String> {
        CONNECTION
            .with(|connection| {
                let mut connection = connection.borrow_mut();
                let connection = connection.get_or_insert_with(Connection::open);
                match connection {
                    Ok(connection) => connection.position(window),
                    Err(error) => Err(error.clone()),
                }
            })
            .map_err(|error| format!("ウィンドウ位置を取得できません: {error}"))
    }
}
