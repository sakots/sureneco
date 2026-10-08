use crate::{engine::Engine, http, storage};
use serde_json::{json, Value};
use std::{
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
mod updates;

struct Message {
    command: String,
    payload: Value,
    reply: mpsc::Sender<Result<Value, String>>,
}
pub struct Backend {
    sender: mpsc::Sender<Message>,
    snapshot: Arc<Mutex<Value>>,
}
struct Clipboard(Mutex<Option<arboard::Clipboard>>);
fn copy(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<Clipboard>();
    let mut clipboard = state.0.lock().unwrap();
    if clipboard.is_none() {
        *clipboard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
    }
    clipboard
        .as_mut()
        .unwrap()
        .set_text(id)
        .map_err(|e| e.to_string())
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(windows)]
fn notification_app_id() -> &'static str {
    if cfg!(debug_assertions) {
        "io.github.sakots.sureneco.dev"
    } else {
        "io.github.sakots.sureneco"
    }
}

#[cfg(windows)]
fn register_windows_notifications(app: &AppHandle) -> Result<(), String> {
    use windows::{core::PCWSTR, Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID};
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let id = notification_app_id();
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(format!("Software\\Classes\\AppUserModelId\\{id}"))
        .map_err(|e| e.to_string())?;
    key.set_value("DisplayName", &"sureneco")
        .map_err(|e| e.to_string())?;
    let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    unsafe {
        SetCurrentProcessExplicitAppUserModelID(PCWSTR(wide.as_ptr()))
            .map_err(|e| e.to_string())?;
    }
    if cfg!(debug_assertions) {
        app.deep_link()
            .register("sureneco-notification-dev")
            .map_err(|e| e.to_string())?;
    } else {
        app.deep_link().register_all().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn fit_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use crate::window::{fit, Bounds};
    let was_maximized = window.is_maximized()?;
    if was_maximized {
        window.unmaximize()?;
    }
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    let mut monitors = window.available_monitors()?;
    if let Some(primary) = window.primary_monitor()? {
        monitors.sort_by_key(|monitor| monitor.position() != primary.position());
    }
    let areas: Vec<_> = monitors
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            Bounds {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            }
        })
        .collect();
    let bounds = fit(
        Bounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        &areas,
    );
    let scale = window.scale_factor()?;
    window.set_min_size(Some(tauri::PhysicalSize::new(
        ((400.0 * scale) as u32).min(bounds.width),
        ((600.0 * scale) as u32).min(bounds.height),
    )))?;
    if bounds.width != size.width || bounds.height != size.height {
        let inner = window.inner_size()?;
        window.set_size(tauri::PhysicalSize::new(
            bounds.width.saturating_sub(size.width - inner.width),
            bounds.height.saturating_sub(size.height - inner.height),
        ))?;
    }
    window.set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y))?;
    if was_maximized {
        window.maximize()?;
    }
    Ok(())
}

pub fn notify(app: &AppHandle, title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let notification = notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .appname("sureneco")
            .icon("sureneco")
            .action("default", "surenecoを開く")
            .show()
            .map_err(|e| e.to_string())?;
        let app = app.clone();
        thread::spawn(move || {
            notification.wait_for_action(|action| {
                if action == "default" {
                    show(&app);
                }
            })
        });
    }
    #[cfg(target_os = "windows")]
    {
        use windows::{
            core::HSTRING,
            Data::Xml::Dom::XmlDocument,
            UI::Notifications::{ToastNotification, ToastNotificationManager},
        };
        fn escape(text: &str) -> String {
            text.replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
                .replace('\'', "&apos;")
        }
        let xml = XmlDocument::new().map_err(|e| e.to_string())?;
        let scheme = if cfg!(debug_assertions) {
            "sureneco-notification-dev"
        } else {
            "sureneco-notification"
        };
        xml.LoadXml(&HSTRING::from(format!("<toast activationType=\"protocol\" launch=\"{scheme}://notifications\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>", escape(&title), escape(&body)))).map_err(|e| e.to_string())?;
        let toast = ToastNotification::CreateToastNotification(&xml).map_err(|e| e.to_string())?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(notification_app_id()))
            .and_then(|notifier| notifier.Show(&toast))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn start(app: &AppHandle, available: bool) -> Result<Backend, String> {
    let path = storage::directory()?.join("state.json");
    let saved = storage::read(&path)?;
    let (sender, receiver) = mpsc::channel::<Message>();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let snapshot = Arc::new(Mutex::new(Value::Null));
    let cached = snapshot.clone();
    let frontend_snapshot = snapshot.clone();
    let app = app.clone();
    thread::spawn(move || {
        let event_app = app.clone();
        let notification_app = app.clone();
        let engine = Engine::new(
            saved,
            |url| http::fetch(&url),
            move |text| storage::write(&path, &text),
            move |text| {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    *cached.lock().unwrap() = value.clone();
                    let _ = event_app.emit("state", value);
                }
            },
            move |text| {
                let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                notify(
                    &notification_app,
                    value["title"].as_str().unwrap_or("友人戦募集").into(),
                    value["body"].as_str().unwrap_or("").into(),
                )
            },
        );
        let engine = match engine {
            Ok(engine) => engine,
            Err(error) => {
                let _ = ready_tx.send(Err(error));
                return;
            }
        };
        #[cfg(target_os = "linux")]
        let notification_available = available && notify_rust::get_server_information().is_ok();
        #[cfg(not(target_os = "linux"))]
        let notification_available = available;
        match engine.request(
            "notification_status",
            json!({"available": notification_available}),
        ) {
            Ok(value) => {
                *snapshot.lock().unwrap() = value;
                let _ = ready_tx.send(Ok(()));
            }
            Err(error) => {
                let _ = ready_tx.send(Err(error));
                return;
            }
        }
        let mut deadline = Instant::now();
        loop {
            match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(message) => {
                    let result = engine.request(&message.command, message.payload);
                    if ["refresh", "watch", "settings"].contains(&message.command.as_str()) {
                        deadline = Instant::now() + Duration::from_secs(engine.interval());
                    }
                    let _ = message.reply.send(result);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Err(error) = engine.request("refresh", json!({})) {
                        eprintln!("監視エラー: {error}");
                    }
                    deadline = Instant::now() + Duration::from_secs(engine.interval());
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    ready_rx.recv().map_err(|e| e.to_string())??;
    Ok(Backend {
        sender,
        snapshot: frontend_snapshot,
    })
}

fn launch(app: &AppHandle, value: Value) -> Result<(), String> {
    let id = value["id"].as_str().ok_or("ルームIDが不正です。")?;
    copy(app, id)?;
    let settings = &value["settings"];
    let mode = settings["launcher_mode"].as_str().unwrap_or("default");
    if mode == "default" {
        return open::that("https://game.mahjongsoul.com/").map_err(|e| e.to_string());
    }
    let path = settings["launcher_path"]
        .as_str()
        .ok_or("実行ファイルが不正です。")?;
    spawn_application(path, launcher_arguments(settings)?)
}

fn launcher_arguments(settings: &Value) -> Result<Vec<String>, String> {
    let mode = settings["launcher_mode"].as_str().unwrap_or("application");
    let mut args: Vec<String> = Vec::new();
    if mode == "browser" {
        for (key, flag) in [
            ("launcher_profile", "--profile-directory="),
            ("launcher_user_data_dir", "--user-data-dir="),
        ] {
            if let Some(value) = settings[key].as_str().filter(|v| !v.is_empty()) {
                args.push(format!("{flag}{value}"));
            }
        }
        args.push("https://game.mahjongsoul.com/".into());
    } else {
        args =
            serde_json::from_value(settings["launcher_args"].clone()).map_err(|e| e.to_string())?;
    }
    Ok(args)
}

fn spawn_application(path: &str, args: Vec<String>) -> Result<(), String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(parent) = std::path::Path::new(path).parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008 | 0x00000200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("雀魂の起動に失敗しました: {path}（{e}）"))?;
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if status.success() {
                return Ok(());
            }
            return Err(format!("雀魂の起動に失敗しました: {path}（{status}）"));
        }
        thread::sleep(Duration::from_millis(25));
    }
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_browser_profile_and_application_arguments() {
        assert_eq!(launcher_arguments(&json!({"launcher_mode":"browser", "launcher_profile":"Profile 1", "launcher_user_data_dir":"/home/example/Browser Data"})).unwrap(), vec!["--profile-directory=Profile 1", "--user-data-dir=/home/example/Browser Data", "https://game.mahjongsoul.com/"]);
        assert_eq!(launcher_arguments(&json!({"launcher_mode":"application", "launcher_args":["-applaunch", "12345", "an argument with spaces"]})).unwrap(), vec!["-applaunch", "12345", "an argument with spaces"]);
    }
    #[cfg(unix)]
    #[test]
    fn launches_without_shell_interpretation_and_reports_early_failure() {
        use std::{fs, os::unix::fs::PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("launcher with spaces");
        let output = directory.path().join("args");
        fs::write(
            &executable,
            "#!/bin/sh\nout=$1\nshift\nprintf '%s\\n' \"$@\" > \"$out\"\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        spawn_application(
            executable.to_str().unwrap(),
            vec![
                output.to_string_lossy().into(),
                "an argument with spaces".into(),
                "$(do-not-run)".into(),
            ],
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(output).unwrap(),
            "an argument with spaces\n$(do-not-run)\n"
        );
        assert!(
            spawn_application("/bin/sh", vec!["-c".into(), "exit 7".into()])
                .unwrap_err()
                .contains("7")
        );
        assert!(spawn_application("/missing/sureneco-launcher", vec![]).is_err());
    }
}

#[tauri::command]
async fn request(
    app: AppHandle,
    backend: tauri::State<'_, Backend>,
    command: String,
    payload: Value,
) -> Result<Value, String> {
    if command == "snapshot" {
        return Ok(backend.snapshot.lock().unwrap().clone());
    }
    if ![
        "refresh",
        "watch",
        "settings",
        "open_thread",
        "copy_room_id",
        "launch",
    ]
    .contains(&command.as_str())
    {
        return Err("未対応の操作です。".into());
    }
    let sender = backend.sender.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, result) = mpsc::channel();
        sender
            .send(Message {
                command: command.clone(),
                payload,
                reply,
            })
            .map_err(|e| e.to_string())?;
        let value = result.recv().map_err(|e| e.to_string())??;
        match command.as_str() {
            "open_thread" => {
                open::that(value.as_str().ok_or("URLが不正です。")?).map_err(|e| e.to_string())?
            }
            "copy_room_id" => copy(&app, value.as_str().unwrap_or_default())?,
            "launch" => launch(&app, value)?,
            _ => return Ok(value),
        }
        Ok(Value::Null)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            request,
            updates::update_state,
            updates::check_update,
            updates::download_update,
            updates::install_update,
            updates::open_release
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let window =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .on_navigation(|url| {
                        crate::window::allowed_navigation(url, cfg!(debug_assertions))
                    })
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .build()?;
            let _ = fit_window(&window);
            #[cfg(windows)]
            let notification_available = register_windows_notifications(&handle).is_ok();
            #[cfg(not(windows))]
            let notification_available = true;
            let activation_app = handle.clone();
            app.deep_link().on_open_url(move |_| show(&activation_app));
            let backend = match start(&handle, notification_available) {
                Ok(backend) => backend,
                Err(error) => {
                    let error_app = handle.clone();
                    app.dialog()
                        .message(format!(
                            "{error}\n設定ファイル: {}",
                            storage::directory()
                                .unwrap_or_default()
                                .join("state.json")
                                .display()
                        ))
                        .title("surenecoを起動できません")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .show(move |_| error_app.exit(1));
                    return Ok(());
                }
            };
            app.manage(backend);
            app.manage(Clipboard(Mutex::new(None)));
            app.manage(updates::Controller::new(&handle));
            let open = MenuItem::with_id(app, "open", "surenecoを開く", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "今すぐ更新", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &refresh, &separator, &quit])?;
            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("sureneco · 友人戦募集通知")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "refresh" => {
                        let backend = app.state::<Backend>();
                        let (reply, _) = mpsc::channel();
                        let _ = backend.sender.send(Message {
                            command: "refresh".into(),
                            payload: json!({}),
                            reply,
                        });
                    }
                    "quit" => {
                        let _ = app.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show(tray.app_handle());
                    }
                })
                .build(app);
            if tray.is_ok() {
                let window = app.get_webview_window("main").unwrap();
                let close_window = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = close_window
                            .app_handle()
                            .save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
                        let _ = close_window.hide();
                    }
                });
            }
            let update_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let _ = updates::check(&update_app).await;
                    // OSの監視スレッドとは独立した待機。
                    tauri::async_runtime::spawn_blocking(|| {
                        thread::sleep(Duration::from_secs(6 * 3600))
                    })
                    .await
                    .ok();
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = app.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
            }
        }),
        Err(error) => {
            eprintln!("surenecoを起動できません: {error}");
        }
    }
}
