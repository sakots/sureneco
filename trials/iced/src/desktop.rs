#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Show,
    Refresh,
    Quit,
}

/// Construct, poll, and drop on the Iced/UI thread. Native menus are not Send.
pub struct Desktop {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    native: Native,
    status: String,
    was_available: bool,
}

impl Desktop {
    pub fn new() -> Result<Self, String> {
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        {
            Ok(Self {
                native: Native::new()?,
                status: "トレイ: ホストの到達性を確認中（確認完了まで閉じると終了）".into(),
                was_available: false,
            })
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            Ok(Self {
                status: "このOSでは試作のトレイを利用できません（閉じると終了）。".into(),
                was_available: false,
            })
        }
    }

    pub fn available(&self) -> bool {
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        {
            self.native.available()
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            false
        }
    }

    pub fn status(&self) -> &str {
        &self.status
    }

    pub fn poll(&mut self) -> Option<Action> {
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        {
            self.native.pump();
            let available = self.available();
            self.native.update_status(available, &mut self.status);
            let lost_host = self.was_available && !available;
            self.was_available = available;
            // A host may disappear while the main window is hidden. Recover it,
            // rather than leaving an inaccessible background process running.
            if lost_host {
                return Some(Action::Show);
            }
            self.native.action()
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            None
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem},
    Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
};

#[cfg(any(target_os = "linux", target_os = "windows"))]
struct Native {
    tray: TrayIcon,
    show: MenuItem,
    refresh: MenuItem,
    quit: MenuItem,
    #[cfg(target_os = "linux")]
    host: linux::HostMonitor,
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
impl Native {
    fn new() -> Result<Self, String> {
        #[cfg(target_os = "linux")]
        linux::initialize()?;

        let show = MenuItem::new("表示", true, None);
        let refresh = MenuItem::new("更新", true, None);
        let quit = MenuItem::new("終了", true, None);
        let menu = Menu::with_items(&[&show, &refresh, &quit])
            .map_err(|error| format!("トレイメニューを作成できません: {error}"))?;
        let icon = Icon::from_rgba(ICON_RGBA.to_vec(), 16, 16)
            .map_err(|error| format!("トレイアイコンを作成できません: {error}"))?;
        let tray = TrayIconBuilder::new()
            .with_id("sureneco-iced")
            .with_menu(Box::new(menu))
            .with_tooltip("すれねこ · Iced")
            .with_menu_on_left_click(false)
            .with_icon(icon)
            .build()
            .map_err(|error| format!("トレイを作成できません: {error}"))?;
        Ok(Self {
            tray,
            show,
            refresh,
            quit,
            #[cfg(target_os = "linux")]
            host: linux::HostMonitor::start()?,
        })
    }

    fn pump(&mut self) {
        #[cfg(target_os = "linux")]
        {
            // Never run GTK's blocking main loop or let a busy GLib source
            // monopolize Iced. This is the same main thread that initialized GTK.
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2);
            for _ in 0..64 {
                if !gtk::events_pending() || std::time::Instant::now() >= deadline {
                    break;
                }
                gtk::main_iteration_do(false);
            }
            self.host.poll();
        }
        // Iced/winit dispatches the tray's native Win32 window messages.
    }

    fn available(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.host.available()
        }
        #[cfg(target_os = "windows")]
        {
            // A successfully constructed HWND alone does not prove Explorer is
            // hosting the icon. The crate asks Shell_NotifyIconGetRect here.
            self.tray.rect().is_some()
        }
    }

    fn update_status(&self, available: bool, status: &mut String) {
        #[cfg(target_os = "linux")]
        let text = self.host.status();
        #[cfg(target_os = "windows")]
        let text = if available {
            "トレイ: Windows通知領域に接続済み（閉じると常駐）"
        } else {
            "トレイを利用できません: Windows通知領域に到達できません（閉じると終了）。"
        };
        #[cfg(target_os = "linux")]
        let _ = available;
        if status != text {
            status.clear();
            status.push_str(text);
        }
    }

    fn action(&self) -> Option<Action> {
        while let Ok(event) = MenuEvent::receiver().try_recv() {
            if event.id == *self.show.id() {
                return Some(Action::Show);
            }
            if event.id == *self.refresh.id() {
                return Some(Action::Refresh);
            }
            if event.id == *self.quit.id() {
                return Some(Action::Quit);
            }
        }
        // AppIndicator deliberately exposes its host-owned menu, not icon click
        // events. Linux users choose the first (Show) menu item instead.
        while let Ok(event) = TrayIconEvent::receiver().try_recv() {
            if let TrayIconEvent::Click {
                id,
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if &id == self.tray.id() {
                    return Some(Action::Show);
                }
            }
        }
        None
    }
}

// Tiny opaque cat silhouette, embedded as RGBA; no runtime image decoder.
#[cfg(any(target_os = "linux", target_os = "windows"))]
const ICON_RGBA: [u8; 16 * 16 * 4] = {
    let mut pixels = [0; 16 * 16 * 4];
    let mut y = 0;
    while y < 16 {
        let mut x = 0;
        while x < 16 {
            let offset = (y * 16 + x) * 4;
            let cat = (y >= 6 && y <= 12 && x >= 3 && x <= 12)
                || (y >= 3 && y <= 6 && (x == 3 || x == 4 || x == 11 || x == 12));
            let eye = y == 8 && (x == 6 || x == 9);
            pixels[offset] = if cat && !eye { 245 } else { 45 };
            pixels[offset + 1] = if cat && !eye { 245 } else { 91 };
            pixels[offset + 2] = if cat && !eye { 245 } else { 145 };
            pixels[offset + 3] = 255;
            x += 1;
        }
        y += 1;
    }
    pixels
};

#[cfg(target_os = "linux")]
mod linux {
    use std::{
        sync::mpsc::{self, Receiver, SyncSender, TrySendError},
        thread,
        time::{Duration, Instant},
    };

    const PROBE_TIMEOUT: Duration = Duration::from_millis(1200);
    const PROBE_INTERVAL: Duration = Duration::from_millis(500);
    const MAX_AGE: Duration = Duration::from_secs(3);
    const WATCHER: &str = "org.kde.StatusNotifierWatcher";
    // libappindicator normalizes the tray-icon-generated ID into this path.
    const ITEM_PATH: &str = "/org/ayatana/NotificationItem/tray_icon_tray_app_sureneco_iced";

    pub(super) fn initialize() -> Result<(), String> {
        // libappindicator-sys panics when neither optional runtime library is
        // installed. Check first so an unavailable tray is a visible UI error.
        unsafe {
            libloading::Library::new("libayatana-appindicator3.so.1")
                .or_else(|_| libloading::Library::new("libappindicator3.so.1"))
        }
        .map_err(|error| format!("トレイ用AppIndicatorライブラリーを読み込めません: {error}"))?;
        gtk::init().map_err(|error| format!("トレイ用GTKを初期化できません: {error}"))
    }

    struct Report {
        at: Instant,
        result: Result<(), String>,
    }

    impl Report {
        fn available_at(&self, now: Instant) -> bool {
            self.result.is_ok() && now.saturating_duration_since(self.at) < MAX_AGE
        }
    }

    pub(super) struct HostMonitor {
        reports: Receiver<Report>,
        stop: SyncSender<()>,
        latest: Option<Report>,
        disconnected: bool,
    }

    impl HostMonitor {
        pub(super) fn start() -> Result<Self, String> {
            let (sender, reports) = mpsc::sync_channel(1);
            let (stop, stopping) = mpsc::sync_channel(1);
            thread::Builder::new()
                .name("sureneco-iced-tray-host".into())
                .spawn(move || {
                    let runtime = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(runtime) => runtime,
                        Err(error) => {
                            let _ = sender.try_send(Report {
                                at: Instant::now(),
                                result: Err(format!(
                                    "ホスト確認スレッドを初期化できません: {error}"
                                )),
                            });
                            return;
                        }
                    };
                    let mut connection = None;
                    loop {
                        // Bounds session-bus connection/handshake and every
                        // native property/method request together, off the UI.
                        let result = runtime.block_on(async {
                            tokio::time::timeout(PROBE_TIMEOUT, probe(&mut connection))
                                .await
                                .map_err(|_| {
                                    "トレイホストのD-Bus応答がタイムアウトしました。".to_owned()
                                })?
                        });
                        match sender.try_send(Report {
                            at: Instant::now(),
                            result,
                        }) {
                            Err(TrySendError::Disconnected(_)) => break,
                            Ok(()) | Err(TrySendError::Full(_)) => {}
                        }
                        match stopping.recv_timeout(PROBE_INTERVAL) {
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                })
                .map_err(|error| format!("トレイホストの確認を開始できません: {error}"))?;
            Ok(Self {
                reports,
                stop,
                latest: None,
                disconnected: false,
            })
        }

        pub(super) fn poll(&mut self) {
            loop {
                match self.reports.try_recv() {
                    Ok(report) => self.latest = Some(report),
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        self.disconnected = true;
                        break;
                    }
                }
            }
        }

        pub(super) fn available(&self) -> bool {
            !self.disconnected
                && self
                    .latest
                    .as_ref()
                    .is_some_and(|report| report.available_at(Instant::now()))
        }

        pub(super) fn status(&self) -> &str {
            if self.disconnected {
                if let Some(Report {
                    result: Err(error), ..
                }) = &self.latest
                {
                    return error;
                }
                return "トレイを利用できません: ホスト確認スレッドが終了しました（閉じると終了）。";
            }
            match &self.latest {
                Some(report) if report.available_at(Instant::now()) => {
                    "トレイ: StatusNotifierホスト・アイコン登録確認済み（閉じると常駐）"
                }
                Some(report) => match &report.result {
                    Err(error) => error,
                    Ok(()) => "トレイを利用できません: ホスト確認が期限切れです（閉じると終了）。",
                },
                None => "トレイ: ホストの到達性を確認中（確認完了まで閉じると終了）",
            }
        }
    }

    impl Drop for HostMonitor {
        fn drop(&mut self) {
            // Do not join a D-Bus request on the UI thread. The bounded request
            // finishes independently; dropping this sender also wakes the wait.
            let _ = self.stop.try_send(());
        }
    }

    async fn probe(connection: &mut Option<zbus::Connection>) -> Result<(), String> {
        probe_bus(connection)
            .await
            .map_err(|error| format!("トレイを利用できません: {error}（閉じると終了）。"))
    }

    async fn probe_bus(connection: &mut Option<zbus::Connection>) -> Result<(), String> {
        if connection.as_ref().is_none_or(zbus::Connection::is_closed) {
            *connection = Some(
                zbus::Connection::session()
                    .await
                    .map_err(|error| error.to_string())?,
            );
        }
        let connection = connection
            .as_ref()
            .expect("session connection initialized above");
        let watcher: zbus::Proxy<'_> = zbus::proxy::Builder::new(connection)
            .destination(WATCHER)
            .path("/StatusNotifierWatcher")
            .interface(WATCHER)
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .map_err(|error| error.to_string())?;
        let registered: bool = watcher
            .get_property("IsStatusNotifierHostRegistered")
            .await
            .map_err(|error| error.to_string())?;
        if !registered {
            return Err("StatusNotifierトレイホストが登録されていません".into());
        }
        let items: Vec<String> = watcher
            .get_property("RegisteredStatusNotifierItems")
            .await
            .map_err(|error| error.to_string())?;
        let bus = zbus::Proxy::new(
            connection,
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
        )
        .await
        .map_err(|error| error.to_string())?;
        for item in &items {
            let Some(service) = own_item_service(item) else {
                continue;
            };
            let pid: u32 = bus
                .call("GetConnectionUnixProcessID", &(service,))
                .await
                .map_err(|error| error.to_string())?;
            if pid != std::process::id() {
                continue;
            }
            // Verify the advertised item itself, not merely a watcher name or
            // another process's identically named icon, remains reachable.
            let item =
                zbus::Proxy::new(connection, service, ITEM_PATH, "org.freedesktop.DBus.Peer")
                    .await
                    .map_err(|error| error.to_string())?;
            item.call::<_, _, ()>("Ping", &())
                .await
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
        Err("このアプリのアイコンがトレイホストに登録されていません".into())
    }

    fn own_item_service(item: &str) -> Option<&str> {
        let service = item.strip_suffix(ITEM_PATH)?;
        (!service.is_empty() && !service.contains('/')).then_some(service)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_missing_failed_or_stale_host_never_allows_hiding() {
            let now = Instant::now();
            let report = Report {
                at: now,
                result: Ok(()),
            };
            assert!(report.available_at(now));
            assert!(!report.available_at(now + MAX_AGE));
            let failed = Report {
                at: now,
                result: Err("host lost".into()),
            };
            assert!(!failed.available_at(now));
        }

        #[test]
        fn registration_must_match_our_full_item_path() {
            assert_eq!(
                own_item_service(&format!(":1.42{ITEM_PATH}")),
                Some(":1.42")
            );
            assert!(own_item_service(ITEM_PATH).is_none());
            assert!(own_item_service(&format!(":1.42/other{ITEM_PATH}")).is_none());
            assert!(own_item_service(":1.42/org/ayatana/NotificationItem/other").is_none());
        }
    }
}
