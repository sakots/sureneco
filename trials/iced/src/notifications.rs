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
    use std::{
        ffi::OsString,
        os::windows::ffi::OsStringExt,
        path::{Path, PathBuf},
    };
    use windows::{
        core::{w, Interface, HSTRING, PCWSTR},
        Win32::{
            Storage::EnhancedStorage::PKEY_AppUserModel_ID,
            System::{
                Com::{
                    CoCreateInstance, CoTaskMemFree, IPersistFile, StructuredStorage::PROPVARIANT,
                    CLSCTX_INPROC_SERVER,
                },
                Variant::VT_LPWSTR,
                WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
            },
            UI::Shell::{
                FOLDERID_Programs, IShellLinkW, PropertiesSystem::IPropertyStore,
                SHGetKnownFolderPath, SHStrDupW, SetCurrentProcessExplicitAppUserModelID,
                ShellLink, KF_FLAG_DEFAULT,
            },
        },
        UI::Notifications::{NotificationSetting, ToastNotificationManager, ToastNotifier},
    };
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    // Never share the production or development Tauri app's registration.
    const APP_ID: &str = "io.github.sakots.sureneco.iced";
    static REGISTRATION: std::sync::LazyLock<Result<HSTRING, String>> =
        std::sync::LazyLock::new(|| {
            let app_id = HSTRING::from(APP_ID);
            let executable = std::env::current_exe()
                .map_err(|error| format!("通知用EXEの場所を取得できません: {error}"))?;
            // Shell folders may be redirected; use the current user's known folder.
            let folder = unsafe { SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_DEFAULT, None) }
                .map_err(|error| format!("スタートメニューの場所を取得できません: {error}"))?;
            let directory = PathBuf::from(OsString::from_wide(unsafe { folder.as_wide() }));
            unsafe { CoTaskMemFree(Some(folder.0.cast())) };
            std::fs::create_dir_all(&directory)
                .map_err(|error| format!("通知用スタートメニューを準備できません: {error}"))?;
            let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey(format!("Software\\Classes\\AppUserModelId\\{APP_ID}"))
                .map_err(|error| format!("通知アプリIDを登録できません: {error}"))?;
            key.set_value("DisplayName", &"すれねこ · Iced")
                .map_err(|error| format!("通知アプリ名を登録できません: {error}"))?;
            unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(app_id.as_ptr())) }
                .map_err(|error| format!("通知プロセスIDを設定できません: {error}"))?;
            // Repair our own link on every launch, including after moving a ZIP build.
            install_shortcut(&executable, &directory.join("sureneco-iced.lnk"), &app_id)?;
            Ok(app_id)
        });

    fn install_shortcut(
        executable: &Path,
        shortcut: &Path,
        app_id: &HSTRING,
    ) -> Result<(), String> {
        let target = HSTRING::from(executable);
        let destination = HSTRING::from(shortcut);
        let working_directory = HSTRING::from(
            executable
                .parent()
                .ok_or("通知用EXEの親フォルダーがありません。")?,
        );
        // COM has been initialized by the caller. All PCWSTR inputs stay alive;
        // the LPWSTR PROPVARIANT owns its CoTaskMem string and frees it on Drop.
        let result: windows::core::Result<()> = (|| unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&target)?;
            link.SetWorkingDirectory(&working_directory)?;
            link.SetDescription(w!("すれねこ · Iced"))?;
            let properties: IPropertyStore = link.cast()?;
            let value = SHStrDupW(PCWSTR(app_id.as_ptr()))?;
            let mut identity = PROPVARIANT::default();
            let fields = &mut *identity.Anonymous.Anonymous;
            fields.vt = VT_LPWSTR;
            fields.Anonymous.pwszVal = value;
            properties.SetValue(&PKEY_AppUserModel_ID, &identity)?;
            properties.Commit()?;
            link.cast::<IPersistFile>()?.Save(&destination, true)
        })();
        result.map_err(|error| {
            format!(
                "通知用ショートカットを保存できません（{}）: {error}",
                shortcut.display()
            )
        })
    }

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

    fn initialize_sender(notifier: &ToastNotifier, app_id: &HSTRING) -> Result<(), String> {
        use std::time::{SystemTime, UNIX_EPOCH};
        use windows::{
            Data::Xml::Dom::XmlDocument,
            Foundation::{DateTime, IReference, PropertyValue},
            UI::Notifications::ToastNotification,
        };

        // 未パッケージアプリは最初の送信より前にSettingを取得すると失敗する。
        // Microsoft.Toolkitと同様、非表示の実送信でOS側を初期化してから照会する。
        let tag = HSTRING::from("iced-register");
        let group = HSTRING::from("iced-setup");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("通知の有効期限を取得できません: {error}"))?;
        // Windows時刻は1601年基準の100ns単位。初期登録通知は15秒で失効する。
        let expires = now.as_nanos() / 100 + (11_644_473_600u128 + 15) * 10_000_000;
        let expires = DateTime {
            UniversalTime: i64::try_from(expires)
                .map_err(|error| format!("通知の有効期限を変換できません: {error}"))?,
        };
        let bootstrap = (|| -> windows::core::Result<ToastNotification> {
            let xml = XmlDocument::new()?;
            xml.LoadXml(&HSTRING::from(
                "<toast><visual><binding template=\"ToastGeneric\"><text>通知の初期登録</text></binding></visual><audio silent=\"true\"/></toast>",
            ))?;
            let toast = ToastNotification::CreateToastNotification(&xml)?;
            toast.SetSuppressPopup(true)?;
            toast.SetTag(&tag)?;
            toast.SetGroup(&group)?;
            let expiration: IReference<DateTime> = PropertyValue::CreateDateTime(expires)?.cast()?;
            toast.SetExpirationTime(&expiration)?;
            Ok(toast)
        })().map_err(|error| format!("初回登録通知を準備できません: {error}"))?;
        notifier
            .Show(&bootstrap)
            .map_err(|error| format!("初回登録通知をOSへ送信できません: {error}"))?;
        // 他の募集通知を消さず、初期登録用のタグ・グループだけを削除する。
        ToastNotificationManager::History()
            .and_then(|history| history.RemoveGroupedTagWithId(&tag, &group, app_id))
            .map_err(|error| format!("初回登録通知の履歴を削除できません: {error}"))?;
        Ok(())
    }

    pub(super) fn with_notifier<T>(
        send: impl FnOnce(&ToastNotifier) -> Result<T, String>,
    ) -> Result<T, String> {
        // Initialize COM before creating a ShellLink or touching the WinRT notifier.
        let _apartment = Apartment::new()?;
        let app_id = REGISTRATION.as_ref().map_err(Clone::clone)?;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(app_id)
            .map_err(|error| format!("Windows通知に接続できません: {error}"))?;
        static SENDER_READY: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
        SENDER_READY
            .get_or_init(|| initialize_sender(&notifier, app_id))
            .as_ref()
            .map_err(Clone::clone)?;
        let setting = notifier
            .Setting()
            .map_err(|error| format!("Windows通知設定を取得できません: {error}"))?;
        if setting != NotificationSetting::Enabled {
            return Err(format!("Windowsの通知設定により無効です: {setting:?}"));
        }
        send(&notifier)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{ffi::OsString, os::windows::ffi::OsStringExt};
        use windows::Win32::{System::Com::STGM_READ, UI::Shell::SLGP_RAWPATH};

        #[test]
        fn shortcut_persists_notification_identity_and_updates_a_moved_unicode_executable() {
            let _apartment = Apartment::new().unwrap();
            let directory = tempfile::tempdir().unwrap();
            let shortcut = directory.path().join("通知 試験.lnk");
            let app_id = HSTRING::from(APP_ID);
            for folder in ["最初の場所", "移動後の場所"] {
                let executable = directory.path().join(folder).join("すれねこ iced.exe");
                std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
                std::fs::write(&executable, []).unwrap();
                install_shortcut(&executable, &shortcut, &app_id).unwrap();
                let loaded: IShellLinkW =
                    unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap() };
                let persisted: IPersistFile = loaded.cast().unwrap();
                unsafe {
                    persisted
                        .Load(&HSTRING::from(shortcut.as_path()), STGM_READ)
                        .unwrap()
                };
                let mut target = [0u16; 32768];
                unsafe {
                    loaded
                        .GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
                        .unwrap();
                }
                let length = target.iter().position(|&unit| unit == 0).unwrap();
                let target = std::path::PathBuf::from(OsString::from_wide(&target[..length]));
                assert_eq!(
                    std::fs::canonicalize(target).unwrap(),
                    std::fs::canonicalize(&executable).unwrap()
                );
                let properties: IPropertyStore = loaded.cast().unwrap();
                let identity = unsafe { properties.GetValue(&PKEY_AppUserModel_ID).unwrap() };
                unsafe {
                    assert_eq!(identity.Anonymous.Anonymous.vt, VT_LPWSTR);
                    assert_eq!(
                        identity
                            .Anonymous
                            .Anonymous
                            .Anonymous
                            .pwszVal
                            .to_string()
                            .unwrap(),
                        APP_ID
                    );
                }
            }
        }
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
