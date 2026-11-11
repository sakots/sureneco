#[derive(serde::Deserialize)]
struct Notification {
    title: String,
    body: String,
}

#[cfg(target_os = "linux")]
pub fn status() -> (bool, String) {
    match notify_rust::get_server_information() {
        Ok(server) => (true, format!("OS通知: {} (D-Bus接続確認済み)", server.name)),
        Err(error) => (false, format!("OS通知を利用できません: {error}")),
    }
}

#[cfg(target_os = "windows")]
pub fn status() -> (bool, String) {
    match windows_native::with_notifier(|_| Ok(())) {
        Ok(()) => (true, "OS通知: Windows (Iced専用アプリID登録済み)".into()),
        Err(error) => (false, format!("OS通知を利用できません: {error}")),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub fn status() -> (bool, String) {
    (false, "このOSでは試作のOS通知を利用できません。".into())
}

pub fn show(text: String) -> Result<(), String> {
    let event: Notification = serde_json::from_str(&text)
        .map_err(|error| format!("OS通知のデータが不正です: {error}"))?;
    deliver(event)
}

#[cfg(target_os = "linux")]
fn deliver(event: Notification) -> Result<(), String> {
    notify_rust::Notification::new()
        .appname("sureneco-iced")
        .summary(&event.title)
        .body(&event.body)
        .show()
        .map(|_| ())
        .map_err(|error| format!("OS通知の送信に失敗しました: {error}"))
}

#[cfg(target_os = "windows")]
fn deliver(event: Notification) -> Result<(), String> {
    use windows::{
        core::HSTRING, Data::Xml::Dom::XmlDocument, UI::Notifications::ToastNotification,
    };
    windows_native::with_notifier(|notifier| {
        let xml = XmlDocument::new().map_err(|error| error.to_string())?;
        xml.LoadXml(&HSTRING::from(format!(
            "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
            escape_xml(&event.title), escape_xml(&event.body)
        )))
        .map_err(|error| error.to_string())?;
        let toast = ToastNotification::CreateToastNotification(&xml)
            .map_err(|error| error.to_string())?;
        notifier.Show(&toast).map_err(|error| error.to_string())
    })
    .map_err(|error| format!("OS通知の送信に失敗しました: {error}"))
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn deliver(_event: Notification) -> Result<(), String> {
    Err("このOSでは試作のOS通知を利用できません。".into())
}

#[cfg(any(target_os = "windows", test))]
fn escape_xml(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(target_os = "windows")]
mod windows_native {
    use windows::{
        core::{HSTRING, PCWSTR},
        Win32::{
            System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
            UI::Shell::SetCurrentProcessExplicitAppUserModelID,
        },
        UI::Notifications::{NotificationSetting, ToastNotificationManager, ToastNotifier},
    };
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    // Never share the production or development Tauri app's registration.
    const APP_ID: &str = "io.github.sakots.sureneco.iced";
    static REGISTRATION: std::sync::LazyLock<Result<(), String>> = std::sync::LazyLock::new(|| {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(format!("Software\\Classes\\AppUserModelId\\{APP_ID}"))
            .map_err(|error| format!("通知アプリIDを登録できません: {error}"))?;
        key.set_value("DisplayName", &"すれねこ · Iced")
            .map_err(|error| format!("通知アプリ名を登録できません: {error}"))?;
        let wide: Vec<u16> = APP_ID.encode_utf16().chain(Some(0)).collect();
        unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(wide.as_ptr())) }
            .map_err(|error| format!("通知プロセスIDを設定できません: {error}"))
    });

    struct Apartment;

    impl Apartment {
        fn new() -> Result<Self, String> {
            unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
                .map_err(|error| format!("Windows通知APIを初期化できません: {error}"))?;
            Ok(Self)
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }

    pub(super) fn with_notifier<T>(
        send: impl FnOnce(&ToastNotifier) -> Result<T, String>,
    ) -> Result<T, String> {
        REGISTRATION.as_ref().map_err(Clone::clone)?;
        // The backend owns notification calls; balance WinRT on that same thread.
        let _apartment = Apartment::new()?;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
            .map_err(|error| format!("Windows通知に接続できません: {error}"))?;
        let setting = notifier.Setting().map_err(|error| error.to_string())?;
        if setting != NotificationSetting::Enabled {
            return Err(format!("Windowsの通知設定により無効です: {setting:?}"));
        }
        send(&notifier)
    }
}

#[cfg(test)]
mod tests {
    use super::escape_xml;

    #[test]
    fn toast_text_cannot_inject_xml() {
        assert_eq!(
            escape_xml("</text><audio src=\"x\"/>&'"),
            "&lt;/text&gt;&lt;audio src=&quot;x&quot;/&gt;&amp;&apos;"
        );
    }

    #[test]
    fn escaping_preserves_unicode_and_escapes_literal_entities_once() {
        assert_eq!(escape_xml("募集 🐈 &amp;\n次"), "募集 🐈 &amp;amp;\n次");
    }
}
