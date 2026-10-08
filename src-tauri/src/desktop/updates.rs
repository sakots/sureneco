use super::{notify, AppHandle, AppHandleExt, Emitter, Manager, StateFlags};
use serde::Serialize;
use std::{collections::HashSet, sync::Mutex, time::Duration};
use tauri::utils::config::BundleType;
use tauri_plugin_updater::{Update, UpdaterExt};

pub const RELEASE_URL: &str = "https://github.com/sakots/sureneco/releases/latest";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    version: String,
    mode: String,
    status: String,
    latest_version: Option<String>,
    progress: u8,
    error: Option<String>,
}
pub struct Controller {
    inner: Mutex<Inner>,
}
struct Inner {
    state: UpdateState,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    notified: HashSet<String>,
}
impl Controller {
    pub fn new(app: &AppHandle) -> Self {
        let nsis = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("package-type")))
            .is_some_and(|p| std::fs::read_to_string(p).is_ok_and(|text| text.trim() == "nsis"));
        let mode = update_mode(
            cfg!(debug_assertions),
            cfg!(windows),
            nsis,
            tauri::utils::platform::bundle_type(),
        );
        Self {
            inner: Mutex::new(Inner {
                state: UpdateState {
                    version: app.package_info().version.to_string(),
                    mode: mode.into(),
                    status: if mode == "disabled" {
                        "disabled"
                    } else {
                        "idle"
                    }
                    .into(),
                    latest_version: None,
                    progress: 0,
                    error: None,
                },
                update: None,
                bytes: None,
                notified: HashSet::new(),
            }),
        }
    }
}
fn update_mode(debug: bool, windows: bool, nsis: bool, bundle: Option<BundleType>) -> &'static str {
    if debug {
        "disabled"
    } else if (windows && nsis)
        || (!windows && matches!(bundle, Some(BundleType::Deb | BundleType::AppImage)))
    {
        "auto"
    } else {
        "manual"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_mode_distinguishes_portable_installed_and_development() {
        assert_eq!(
            update_mode(true, true, true, Some(BundleType::Nsis)),
            "disabled"
        );
        assert_eq!(
            update_mode(false, true, false, Some(BundleType::Nsis)),
            "manual"
        );
        assert_eq!(
            update_mode(false, true, true, Some(BundleType::Nsis)),
            "auto"
        );
        assert_eq!(
            update_mode(false, false, false, Some(BundleType::Deb)),
            "auto"
        );
        assert_eq!(
            update_mode(false, false, false, Some(BundleType::AppImage)),
            "auto"
        );
        assert_eq!(update_mode(false, false, false, None), "manual");
    }
}

fn emit(app: &AppHandle, inner: &Inner) {
    let _ = app.emit("update-state", inner.state.clone());
}
fn failure(app: &AppHandle, error: String) {
    let controller = app.state::<Controller>();
    let mut inner = controller.inner.lock().unwrap();
    inner.state.status = "error".into();
    inner.state.error = Some(error);
    emit(app, &inner);
}
#[tauri::command]
pub fn update_state(controller: tauri::State<'_, Controller>) -> UpdateState {
    controller.inner.lock().unwrap().state.clone()
}

pub async fn check(app: &AppHandle) -> Result<(), String> {
    let controller = app.state::<Controller>();
    {
        let mut inner = controller.inner.lock().unwrap();
        if inner.state.mode == "disabled"
            || ["checking", "downloading", "downloaded", "installing"]
                .contains(&inner.state.status.as_str())
        {
            return Ok(());
        }
        inner.state.status = "checking".into();
        inner.state.error = None;
        emit(app, &inner);
    }
    let result = async {
        let updater = app
            .updater_builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        updater.check().await.map_err(|e| e.to_string())
    }
    .await;
    match result {
        Ok(update) => {
            let mut inner = controller.inner.lock().unwrap();
            let version = update.as_ref().map(|u| u.version.clone());
            inner.state.status = if version.is_some() {
                "available"
            } else {
                "current"
            }
            .into();
            inner.state.latest_version = version.clone();
            inner.update = update;
            emit(app, &inner);
            if let Some(version) = version {
                if inner.notified.insert(version.clone()) {
                    let _ = notify(
                        app,
                        "surenecoの更新".into(),
                        format!("v{version}が公開されました。設定画面から更新できます。"),
                    );
                }
            }
        }
        Err(error) => failure(app, error),
    }
    Ok(())
}
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<(), String> {
    check(&app).await
}

#[tauri::command]
pub async fn download_update(app: AppHandle) -> Result<(), String> {
    let update = {
        let controller = app.state::<Controller>();
        let mut inner = controller.inner.lock().unwrap();
        if inner.state.mode != "auto" {
            return Err("この配布形式は手動更新してください。".into());
        }
        if ["downloading", "downloaded", "installing"].contains(&inner.state.status.as_str()) {
            return Ok(());
        }
        if !["available", "error"].contains(&inner.state.status.as_str()) {
            return Err("ダウンロードできる更新がありません。".into());
        }
        let update = inner
            .update
            .clone()
            .ok_or("ダウンロードできる更新がありません。")?;
        inner.state.status = "downloading".into();
        inner.state.progress = 0;
        inner.state.error = None;
        emit(&app, &inner);
        update
    };
    let event_app = app.clone();
    let mut received = 0_u64;
    match update
        .download(
            move |size, total| {
                received += size as u64;
                let controller = event_app.state::<Controller>();
                let mut inner = controller.inner.lock().unwrap();
                inner.state.progress = total
                    .filter(|total| *total > 0)
                    .map(|total| (received.saturating_mul(100) / total).min(100) as u8)
                    .unwrap_or(0);
                emit(&event_app, &inner);
            },
            || {},
        )
        .await
    {
        Ok(bytes) => {
            let controller = app.state::<Controller>();
            let mut inner = controller.inner.lock().unwrap();
            inner.bytes = Some(bytes);
            inner.state.status = "downloaded".into();
            inner.state.progress = 100;
            emit(&app, &inner);
        }
        Err(error) => failure(&app, error.to_string()),
    }
    Ok(())
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let (update, bytes) = {
        let controller = app.state::<Controller>();
        let mut inner = controller.inner.lock().unwrap();
        if inner.state.mode != "auto" || inner.state.status != "downloaded" {
            return Err("取得済みの更新がありません。".into());
        }
        let update = inner.update.clone().ok_or("取得済みの更新がありません。")?;
        let bytes = inner.bytes.take().ok_or("取得済みの更新がありません。")?;
        inner.state.status = "installing".into();
        emit(&app, &inner);
        (update, bytes)
    };
    let _ = app.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
    let result = tauri::async_runtime::spawn_blocking(move || update.install(&bytes))
        .await
        .map_err(|e| e.to_string())?;
    match result {
        Ok(()) => app.restart(),
        Err(error) => failure(&app, error.to_string()),
    }
    Ok(())
}

#[tauri::command]
pub fn open_release() -> Result<(), String> {
    open::that(RELEASE_URL).map_err(|e| e.to_string())
}
