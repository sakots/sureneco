use crate::model::Snapshot;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use sureneco::{engine::Engine, storage::ConfigStorage};

#[derive(Debug)]
pub enum Command {
    Refresh,
    Watch { id: String, enabled: bool },
    Settings(Value),
    Copy(String),
    Open { id: String, post: Option<u64> },
    Stop,
}

#[derive(Debug)]
pub enum Event {
    Snapshot(Arc<Snapshot>),
    Busy(bool),
    Scheduled {
        at: Instant,
        seconds: u64,
    },
    NotificationStatus(String),
    Completed {
        settings_saved: bool,
        result: Result<String, String>,
    },
    Fatal(String),
    Error(String),
}

pub struct Worker {
    pub events: Receiver<Event>,
    commands: SyncSender<Command>,
    stopping: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Worker {
    pub fn start(directory: PathBuf) -> Result<Self, String> {
        let (commands, receiver) = mpsc::sync_channel(8);
        let (events, event_receiver) = mpsc::channel();
        let stopping = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopping);
        let join = thread::Builder::new()
            .name("sureneco-iced-engine".into())
            .spawn(move || {
                if let Err(error) = run(directory, receiver, &events, &stop) {
                    eprintln!("sureneco-iced backend: {error}");
                    let _ = events.send(Event::Fatal(error));
                }
            })
            .map_err(|error| format!("バックエンドを起動できません: {error}"))?;
        Ok(Self {
            events: event_receiver,
            commands,
            stopping,
            join: Some(join),
        })
    }

    pub fn send(&self, command: Command) -> Result<(), String> {
        self.commands
            .try_send(command)
            .map_err(|error| match error {
                TrySendError::Full(_) => {
                    "操作キューが満杯です。処理完了後に再試行してください。".into()
                }
                TrySendError::Disconnected(_) => {
                    "バックエンドが終了しています。アプリを再起動してください。".into()
                }
            })
    }

    pub fn shutdown(&mut self) -> Option<JoinHandle<()>> {
        self.stopping.store(true, Ordering::Release);
        let _ = self.commands.try_send(Command::Stop);
        self.join.take()
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let Some(join) = self.shutdown() {
            let _ = join.join();
        }
    }
}

fn run(
    directory: PathBuf,
    commands: Receiver<Command>,
    events: &mpsc::Sender<Event>,
    stopping: &AtomicBool,
) -> Result<(), String> {
    // Never follow the production app's configurable-storage pointer or migrate it.
    match std::fs::symlink_metadata(directory.join("config-location.json")) {
        Ok(_) => return Err("試作は config-location.json の保存先切替を読み込みません。独立した --data-dir を指定してください。".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(format!("保存先の確認に失敗しました: {error}")),
    }
    let storage = ConfigStorage::load(directory)?;
    let saved = storage.read()?;
    let latest: Rc<RefCell<Option<Arc<Snapshot>>>> = Rc::new(RefCell::new(None));
    let callback_latest = Rc::clone(&latest);
    let callback_events = events.clone();
    let (notification_available, notification_status) = notification_status();
    let _ = events.send(Event::NotificationStatus(notification_status));
    let engine = Engine::new(
        saved,
        |url| sureneco::http::fetch(&url),
        move |text| storage.save(&text),
        move |text| match serde_json::from_str::<Snapshot>(&text) {
            Ok(snapshot) => {
                let snapshot = Arc::new(snapshot);
                *callback_latest.borrow_mut() = Some(Arc::clone(&snapshot));
                let _ = callback_events.send(Event::Snapshot(snapshot));
            }
            Err(error) => {
                let _ = callback_events.send(Event::Error(format!(
                    "バックエンドのスナップショットが不正です: {error}"
                )));
            }
        },
        show_notification,
    )?;
    let value = engine.request(
        "notification_status",
        json!({"available": notification_available}),
    )?;
    let snapshot = Arc::new(
        serde_json::from_value::<Snapshot>(value)
            .map_err(|error| format!("初期スナップショットを取得できません: {error}"))?,
    );
    *latest.borrow_mut() = Some(Arc::clone(&snapshot));
    let _ = events.send(Event::Snapshot(snapshot));

    let mut clipboard = None;
    let mut next = Instant::now();
    loop {
        let shutting_down = stopping.load(Ordering::Acquire);
        if !shutting_down && Instant::now() >= next {
            let _ = events.send(Event::Busy(true));
            if let Err(error) = engine.request("refresh", json!({"automatic": true})) {
                let _ = events.send(Event::Error(format!("定期更新: {error}")));
            }
            let _ = events.send(Event::Busy(false));
            next = schedule(&engine, events);
            continue;
        }
        // Drain accepted UI commands before closing; do not start another scheduled poll.
        let timeout = if shutting_down {
            Duration::ZERO
        } else {
            next.saturating_duration_since(Instant::now())
                .min(Duration::from_millis(250))
        };
        match commands.recv_timeout(timeout) {
            Ok(Command::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) if shutting_down => break,
            Err(RecvTimeoutError::Timeout) => continue,
            Ok(command) => {
                let settings_saved = matches!(&command, Command::Settings(_));
                let reschedule = matches!(
                    &command,
                    Command::Refresh | Command::Watch { .. } | Command::Settings(_)
                );
                let _ = events.send(Event::Busy(true));
                let result = execute(&engine, command, &mut clipboard);
                let _ = events.send(Event::Completed {
                    settings_saved,
                    result,
                });
                let _ = events.send(Event::Busy(false));
                if reschedule {
                    next = schedule(&engine, events);
                }
            }
        }
    }
    // Engine and native resources are dropped here, on their owning thread.
    Ok(())
}

fn schedule(engine: &Engine, events: &mpsc::Sender<Event>) -> Instant {
    let seconds = engine.interval().max(1);
    let at = Instant::now() + Duration::from_secs(seconds);
    let _ = events.send(Event::Scheduled { at, seconds });
    at
}

fn execute(
    engine: &Engine,
    command: Command,
    clipboard: &mut Option<arboard::Clipboard>,
) -> Result<String, String> {
    match command {
        Command::Refresh => {
            engine.request("refresh", json!({}))?;
            Ok("手動更新が完了しました。".into())
        }
        Command::Watch { id, enabled } => {
            engine.request("watch", json!({"id": id, "enabled": enabled}))?;
            Ok("監視設定を保存しました。".into())
        }
        Command::Settings(settings) => {
            engine.request("settings", json!({"settings": settings}))?;
            Ok("設定を検証・保存しました。".into())
        }
        Command::Copy(id) => {
            let normalized = engine.request("copy_room_id", json!({"id": id}))?;
            let text = normalized.as_str().ok_or("ルームIDの応答が不正です。")?;
            if clipboard.is_none() {
                *clipboard = Some(
                    arboard::Clipboard::new()
                        .map_err(|error| format!("クリップボード: {error}"))?,
                );
            }
            clipboard
                .as_mut()
                .ok_or("クリップボードを初期化できません。")?
                .set_text(text.to_owned())
                .map_err(|error| format!("クリップボード: {error}"))?;
            Ok(format!("ルームID {text} をコピーしました。"))
        }
        Command::Open { id, post } => {
            let payload = match post {
                Some(post) => json!({"id": id, "post": post}),
                None => json!({"id": id}),
            };
            let response = engine.request("open_thread", payload)?;
            let url = response.as_str().ok_or("スレッドURLの応答が不正です。")?;
            open::that(url).map_err(|error| format!("スレッドを開けません: {error}"))?;
            Ok("スレッドをブラウザーで開きました。".into())
        }
        Command::Stop => Err("バックエンドは終了処理中です。".into()),
    }
}

#[cfg(target_os = "linux")]
fn notification_status() -> (bool, String) {
    match notify_rust::get_server_information() {
        Ok(server) => (true, format!("OS通知: {} (D-Bus接続確認済み)", server.name)),
        Err(error) => (false, format!("OS通知を利用できません: {error}")),
    }
}

#[cfg(not(target_os = "linux"))]
fn notification_status() -> (bool, String) {
    (
        false,
        "この試作のOS通知はLinuxのD-Busのみ対応しています。".into(),
    )
}

#[cfg(target_os = "linux")]
fn show_notification(text: String) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    struct Notification {
        title: String,
        body: String,
    }
    let event: Notification = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    notify_rust::Notification::new()
        .appname("sureneco-iced")
        .summary(&event.title)
        .body(&event.body)
        .show()
        .map(|_| ())
        .map_err(|error| format!("OS通知の送信に失敗しました: {error}"))
}

#[cfg(not(target_os = "linux"))]
fn show_notification(_text: String) -> Result<(), String> {
    Err("この試作ではOS通知を利用できません。".into())
}
