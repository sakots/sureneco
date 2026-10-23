use crate::{engine::Engine, http, storage};
use serde_json::{json, Value};
use std::sync::mpsc;
use tauri::{plugin::PluginHandle, AppHandle, Emitter, Manager};

struct Native(PluginHandle<tauri::Wry>);
struct Backend(mpsc::Sender<(String, Value, mpsc::Sender<Result<Value, String>>)>);
fn native(app: &AppHandle, operation: &str, payload: Value) -> Result<Value, String> {
    app.state::<Native>()
        .0
        .run_mobile_plugin::<Value>(
            "execute",
            json!({"operation":operation,"payload":payload.to_string()}),
        )
        .map(|v| v["value"].clone())
        .map_err(|_| "端末の操作に失敗しました。".into())
}
fn engine(app: &AppHandle, command: &str, payload: Value) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel();
    app.state::<Backend>()
        .0
        .send((command.into(), payload, tx))
        .map_err(|_| "処理を開始できません。")?;
    rx.recv()
        .map_err(|_| "処理を完了できません。".to_string())?
}
#[tauri::command]
async fn request(app: AppHandle, command: String, payload: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match command.as_str() {
            "mobile_notification_target" => native(&app, "notification_target", json!({})),
            "mobile_status" => native(&app, "status", json!({})),
            "mobile_permission" => native(&app, "permission", json!({})),
            "mobile_copy_login" => native(&app, "copy_login", payload),
            "mobile_start" => {
                if payload["consent"] != true {
                    return Err("通知利用への同意が必要です。".into());
                }
                let saved = engine(&app, "saved_state", json!({}))?;
                native(
                    &app,
                    "start",
                    json!({"consent":true,"saved":saved.to_string()}),
                )
            }
            "mobile_stop" => native(&app, "stop", json!({})),
            "mobile_delete" => native(&app, "delete", json!({})),
            "mobile_sync" => native(&app, "sync", json!({})),
            "snapshot" => engine(&app, &command, payload),
            "refresh" => {
                if native(&app, "foreground", json!({}))? != true {
                    return Ok(Value::Null);
                }
                engine(&app, &command, payload)
            }
            "settings" | "watch" => {
                if command == "settings"
                    && (payload["settings"]["update_sec"].as_u64().unwrap_or(0) < 60
                        || payload["settings"]["thread_update_sec"]
                            .as_u64()
                            .unwrap_or(0)
                            < 60)
                {
                    return Err("Androidの更新間隔は60秒以上にしてください。".into());
                }
                // Suppress old revisions before any local persistence or network work.
                native(&app, "changing", json!({}))?;
                let value = engine(&app, &command, payload)?;
                let saved = engine(&app, "saved_state", json!({}))?;
                native(&app, "sync_settings", json!({"saved":saved.to_string()}))?;
                Ok(value)
            }
            "copy_room_id" => {
                let id = engine(&app, &command, payload)?;
                native(&app, "copy", json!({"id":id}))
            }
            "open_thread" => {
                let url = engine(&app, &command, payload)?;
                native(&app, "open", json!({"url":url}))
            }
            _ => Err("Androidでは未対応の操作です。".into()),
        }
    })
    .await
    .map_err(|_| "処理を完了できません。".to_string())?
}
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("mobile")
                .setup(|app, api| {
                    app.manage(Native(
                        api.register_android_plugin("sureneco.sakots", "MobilePlugin")?,
                    ));
                    Ok(())
                })
                .build(),
        )
        .setup(|app| {
            http::initialize_android_tls()?;
            let file = app.path().app_data_dir()?.join("state.json");
            let saved = storage::read(&file)?;
            let handle = app.handle().clone();
            let (tx, rx) = mpsc::channel::<(String, Value, mpsc::Sender<Result<Value, String>>)>();
            let (ready, status) = mpsc::channel();
            std::thread::spawn(move || {
                let emit = handle.clone();
                let result = Engine::new(
                    saved,
                    |url| http::fetch(&url),
                    move |text| storage::write(&file, &text),
                    move |text| {
                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            let _ = emit.emit("state", value);
                        }
                    },
                    |_| Ok(()),
                );
                let engine = match result {
                    Ok(engine) => engine,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                let _ = engine.request("notification_status", json!({"available":false}));
                let _ = ready.send(Ok(()));
                for (command, payload, reply) in rx {
                    let _ = reply.send(engine.request(&command, payload));
                }
            });
            status.recv()??;
            app.manage(Backend(tx));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![request])
        .run(tauri::generate_context!())
        .expect("Androidアプリの起動に失敗しました");
}
