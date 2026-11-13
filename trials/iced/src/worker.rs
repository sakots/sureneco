use crate::{config_storage::Storage, model::Snapshot, notifications};
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
use sureneco::engine::Engine;

#[derive(Debug)]
pub enum Command {
    Refresh,
    Watch { id: String, enabled: bool },
    Settings(Value),
    ConfigDirectory(PathBuf),
    Copy { id: String, post: u64 },
    Launch(String),
    Open { id: String, post: Option<u64> },
    Stop,
}

#[derive(Debug)]
pub enum Event {
    Snapshot(Arc<Snapshot>),
    DefaultSettings(Value),
    ConfigDirectory(PathBuf),
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
    pub fn start(storage: Storage) -> Result<Self, String> {
        let (commands, receiver) = mpsc::sync_channel(8);
        let (events, event_receiver) = mpsc::channel();
        let stopping = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopping);
        let join = thread::Builder::new()
            .name("sureneco-iced-engine".into())
            .spawn(move || {
                if let Err(error) = run(
                    storage,
                    receiver,
                    &events,
                    &stop,
                    |url| sureneco::http::fetch(&url),
                    notifications::status,
                ) {
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
    storage: Storage,
    commands: Receiver<Command>,
    events: &mpsc::Sender<Event>,
    stopping: &AtomicBool,
    fetch: impl Fn(String) -> Result<String, String> + 'static,
    notification_status: impl FnOnce() -> (bool, String),
) -> Result<(), String> {
    let saved = storage.read()?;
    let storage = Rc::new(RefCell::new(storage));
    let callback_storage = Rc::clone(&storage);
    let latest: Rc<RefCell<Option<Arc<Snapshot>>>> = Rc::new(RefCell::new(None));
    let callback_latest = Rc::clone(&latest);
    let callback_events = events.clone();
    let (notification_available, notification_status) = notification_status();
    let _ = events.send(Event::NotificationStatus(notification_status));
    let engine = Engine::new(
        saved,
        fetch,
        move |text| callback_storage.borrow().save(&text),
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
        notifications::show,
    )?;
    let _ = events.send(Event::DefaultSettings(
        engine.request("default_settings", json!({}))?,
    ));
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
                let result = execute(&engine, command, &mut clipboard, &storage, events);
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
    storage: &Rc<RefCell<Storage>>,
    events: &mpsc::Sender<Event>,
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
        Command::ConfigDirectory(directory) => {
            let saved = engine.request("saved_state", json!({}))?;
            let text = serde_json::to_string(&saved).map_err(|error| error.to_string())?;
            let directory = storage.borrow_mut().change(&directory, &text)?;
            let message = format!("設定保存先を {} に変更しました。", directory.display());
            let _ = events.send(Event::ConfigDirectory(directory));
            Ok(message)
        }
        Command::Copy { id, post } => {
            let normalized = engine.request("copy_room_id", json!({"id": id}))?;
            let text = normalized.as_str().ok_or("ルームIDの応答が不正です。")?;
            copy_room_id(text, clipboard)?;
            Ok(format!("レス {post}：ルームID {text}をコピーしました。"))
        }
        Command::Launch(id) => {
            let launch = engine.request("launch", json!({"id": id}))?;
            let id = launch["id"].as_str().ok_or("ルームIDの応答が不正です。")?;
            copy_room_id(id, clipboard)?;
            sureneco::launcher::launch(&launch["settings"])?;
            Ok(format!("ルームID {id} をコピーして雀魂を起動しました。ゲーム内の友人戦で貼り付けてください。"))
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

fn copy_room_id(text: &str, clipboard: &mut Option<arboard::Clipboard>) -> Result<(), String> {
    if clipboard.is_none() {
        *clipboard =
            Some(arboard::Clipboard::new().map_err(|error| format!("クリップボード: {error}"))?);
    }
    clipboard
        .as_mut()
        .ok_or("クリップボードを初期化できません。")?
        .set_text(text)
        .map_err(|error| format!("クリップボード: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config_storage::Storage, single_instance};

    fn settings(interval: u64) -> Value {
        let engine =
            Engine::new(None, |_| Ok(String::new()), |_| Ok(()), |_| {}, |_| Ok(())).unwrap();
        let mut settings = engine.request("default_settings", json!({})).unwrap();
        settings["update_sec"] = json!(interval);
        settings
    }

    fn drain(storage: Storage, commands: Vec<Command>) -> Vec<Event> {
        let (sender, receiver) = mpsc::sync_channel(commands.len());
        for command in commands {
            sender.send(command).unwrap();
        }
        let (events, receiver_events) = mpsc::channel();
        run(
            storage,
            receiver,
            &events,
            &AtomicBool::new(true),
            |_| Ok(String::new()),
            || (false, "OS通知: テストでは使用しません。".into()),
        )
        .unwrap();
        drop(events);
        receiver_events.into_iter().collect()
    }

    #[test]
    fn directory_change_drains_commands_and_routes_subsequent_saves() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let target = root.path().join("selected");
        let _base_lock = single_instance::acquire(&base).unwrap().unwrap();
        let storage = Storage::load(base.clone()).unwrap().unwrap();
        let events = drain(
            storage,
            vec![
                Command::Settings(settings(45)),
                Command::ConfigDirectory(target.clone()),
                Command::Settings(settings(90)),
                Command::Stop,
            ],
        );
        let old: Value =
            serde_json::from_str(&std::fs::read_to_string(base.join("state.json")).unwrap())
                .unwrap();
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(target.join("state.json")).unwrap())
                .unwrap();
        assert_eq!(old["settings"]["update_sec"], 45);
        assert_eq!(saved["settings"]["update_sec"], 90);
        let canonical = target.canonicalize().unwrap();
        assert_eq!(
            events
                .iter()
                .filter_map(|event| match event {
                    Event::ConfigDirectory(directory) => Some(directory),
                    _ => None,
                })
                .collect::<Vec<_>>(),
            vec![&canonical]
        );
        let completed = events
            .iter()
            .filter_map(|event| match event {
                Event::Completed {
                    settings_saved,
                    result,
                } => Some((*settings_saved, result)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            completed
                .iter()
                .map(|(saved, _)| *saved)
                .collect::<Vec<_>>(),
            vec![true, false, true]
        );
        assert!(completed.iter().all(|(_, result)| result.is_ok()));
        // A concurrent test's fork may hold an inherited FD briefly before exec.
        let deadline = Instant::now() + Duration::from_secs(2);
        let reopened = loop {
            if let Some(storage) = Storage::load(base.clone()).unwrap() {
                break storage;
            }
            assert!(
                Instant::now() < deadline,
                "保存先のロックが解放されませんでした"
            );
            thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(reopened.directory(), canonical);
        assert_eq!(
            serde_json::from_str::<Value>(&reopened.read().unwrap().unwrap()).unwrap(),
            saved
        );
    }

    #[test]
    fn failed_pointer_save_is_an_operation_error_and_preserves_active_storage() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let target = root.path().join("selected");
        let _base_lock = single_instance::acquire(&base).unwrap().unwrap();
        let storage = Storage::load(base.clone()).unwrap().unwrap();
        std::fs::create_dir(base.join("config-location.json")).unwrap();
        let events = drain(
            storage,
            vec![
                Command::Settings(settings(45)),
                Command::ConfigDirectory(target.clone()),
                Command::Settings(settings(90)),
                Command::Stop,
            ],
        );
        let completed = events
            .iter()
            .filter_map(|event| match event {
                Event::Completed {
                    settings_saved,
                    result,
                } => Some((*settings_saved, result)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(completed.len(), 3);
        assert!(completed[0].1.is_ok());
        assert!(!completed[1].0);
        assert!(completed[1].1.is_err());
        assert!(completed[2].1.is_ok());
        assert!(!events
            .iter()
            .any(|event| matches!(event, Event::Fatal(_) | Event::ConfigDirectory(_))));
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(base.join("state.json")).unwrap())
                .unwrap();
        assert_eq!(saved["settings"]["update_sec"], 90);
        assert!(!target.join("state.json").exists());
    }
}
