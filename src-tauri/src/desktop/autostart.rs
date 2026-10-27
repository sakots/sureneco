use std::path::{Component, Path};

// Serialize this process's status/change operations; OS registrations remain the source of truth.
static REGISTRATION: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn require_release(debug: bool) -> Result<(), String> {
    if debug {
        Err("開発ビルドではログイン時の自動起動を設定できません。配布版を使用してください。".into())
    } else {
        Ok(())
    }
}

fn executable_text(path: &Path) -> Result<&str, String> {
    let text = path
        .to_str()
        .ok_or("自動起動の実行先をUnicodeで表せません。")?;
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        || text.chars().any(char::is_control)
    {
        return Err(
            "自動起動には制御文字や親ディレクトリー参照を含まない絶対パスが必要です。".into(),
        );
    }
    Ok(text)
}

pub(super) fn status() -> Result<bool, String> {
    require_release(cfg!(debug_assertions))?;
    let _guard = REGISTRATION.lock();
    #[cfg(target_os = "linux")]
    return linux::status();
    #[cfg(windows)]
    return windows::status();
    #[cfg(not(any(target_os = "linux", windows)))]
    Err("このOSではログイン時の自動起動に対応していません。".into())
}

pub(super) fn set(enabled: bool) -> Result<bool, String> {
    require_release(cfg!(debug_assertions))?;
    let _guard = REGISTRATION.lock();
    #[cfg(target_os = "linux")]
    return linux::set(enabled);
    #[cfg(windows)]
    return windows::set(enabled);
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = enabled;
        Err("このOSではログイン時の自動起動に対応していません。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_builds_refuse_autostart_before_accessing_os_settings() {
        assert!(require_release(true).unwrap_err().contains("開発ビルド"));
        assert!(require_release(false).is_ok());
        #[cfg(debug_assertions)]
        {
            assert!(status().unwrap_err().contains("開発ビルド"));
            assert!(set(true).unwrap_err().contains("開発ビルド"));
            assert!(set(false).unwrap_err().contains("開発ビルド"));
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::executable_text;
    use std::{
        ffi::OsStr,
        fs::{self, File},
        io::{ErrorKind, Read, Write},
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::{Component, Path, PathBuf},
    };

    // GLib checks argv[0] before expanding %%: keep the application path out of argv[0].
    const PREFIX: &str = "[Desktop Entry]\nType=Application\nVersion=1.0\nName=スレネコチェッカー\nExec=/usr/bin/env -- ";
    const SUFFIX: &str = "\nTerminal=false\nX-Sureneco-Autostart=1\n";

    fn encode_exec(path: &Path) -> Result<String, String> {
        let text = executable_text(path)?;
        if text.contains('=') {
            return Err("Desktop Entryの実行先には等号（=）を使用できません。".into());
        }
        let mut exec = String::with_capacity(text.len() + 2);
        exec.push('"');
        for character in text.chars() {
            match character {
                // Desktop Entry string escaping precedes Exec argument unquoting.
                '\\' => exec.push_str("\\\\\\\\"),
                '"' => exec.push_str("\\\\\""),
                '$' => exec.push_str("\\\\$"),
                '`' => exec.push_str("\\\\`"),
                '%' => exec.push_str("%%"),
                character => exec.push(character),
            }
        }
        exec.push('"');
        Ok(exec)
    }

    fn decode_exec(exec: &str) -> Option<PathBuf> {
        let quoted = exec.strip_prefix('"')?.strip_suffix('"')?;
        let mut unescaped = String::with_capacity(quoted.len());
        let mut characters = quoted.chars();
        while let Some(character) = characters.next() {
            if character == '\\' && characters.next()? != '\\' {
                return None;
            }
            unescaped.push(character);
        }
        let mut text = String::with_capacity(unescaped.len());
        let mut characters = unescaped.chars();
        while let Some(character) = characters.next() {
            match character {
                '\\' => {
                    let escaped = characters.next()?;
                    if !matches!(escaped, '\\' | '"' | '$' | '`') {
                        return None;
                    }
                    text.push(escaped);
                }
                '%' => {
                    if characters.next()? != '%' {
                        return None;
                    }
                    text.push('%');
                }
                '"' | '$' | '`' => return None,
                character => text.push(character),
            }
        }
        let path = PathBuf::from(text);
        (encode_exec(&path).ok()? == exec).then_some(path)
    }

    fn desktop_entry(executable: &Path) -> Result<String, String> {
        Ok(format!("{PREFIX}{}{SUFFIX}", encode_exec(executable)?))
    }

    fn select_executable(appimage: Option<&OsStr>, current: &Path) -> Result<PathBuf, String> {
        let executable = appimage.map(Path::new).unwrap_or(current);
        encode_exec(executable)?;
        if executable.components().any(|part| {
            matches!(part, Component::Normal(name) if name.as_encoded_bytes().starts_with(b".mount_"))
        }) {
            return Err("AppImageの一時展開先は登録できません。元のAppImageの絶対パスが必要です。".into());
        }
        let metadata = fs::metadata(executable)
            .map_err(|error| format!("自動起動の実行先を確認できません: {error}"))?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
            return Err("自動起動の実行先が実行可能なファイルではありません。".into());
        }
        Ok(executable.to_path_buf())
    }

    fn config_directory(xdg: Option<&OsStr>, home: Option<PathBuf>) -> Result<PathBuf, String> {
        let path = match xdg.map(Path::new).filter(|path| path.is_absolute()) {
            Some(path) => path.to_path_buf(),
            None => home
                .ok_or("ユーザーの設定ディレクトリーが見つかりません。")?
                .join(".config"),
        };
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err("自動起動の設定ディレクトリーには絶対パスが必要です。".into());
        }
        Ok(path)
    }

    fn location() -> Result<(PathBuf, PathBuf), String> {
        let appimage = std::env::var_os("APPIMAGE");
        // Do not even depend on the temporary current_exe when APPIMAGE is available.
        let current = if appimage.is_some() {
            PathBuf::new()
        } else {
            std::env::current_exe().map_err(|error| format!("実行先を取得できません: {error}"))?
        };
        let executable = select_executable(appimage.as_deref(), &current)?;
        let config = config_directory(
            std::env::var_os("XDG_CONFIG_HOME").as_deref(),
            dirs::home_dir(),
        )?;
        Ok((config.join("autostart/sureneco.desktop"), executable))
    }

    fn check_parents(path: &Path) -> Result<(), String> {
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err("自動起動の登録先が安全な絶対パスではありません。".into());
        }
        let parent = path
            .parent()
            .ok_or("自動起動の登録先に親ディレクトリーがありません。")?;
        let mut current = PathBuf::new();
        for part in parent.components() {
            current.push(part);
            match fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return Err(format!("自動起動の登録先にシンボリックリンクまたはディレクトリー以外の項目があります: {}", current.display()));
                }
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(format!("自動起動の登録先を確認できません: {error}")),
            }
        }
        Ok(())
    }

    #[derive(PartialEq, Eq)]
    struct Entry {
        contents: String,
        device: u64,
        inode: u64,
    }

    fn read_entry(path: &Path) -> Result<Option<Entry>, String> {
        check_parents(path)?;
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("自動起動の登録を読み取れません: {error}")),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("自動起動の登録先がシンボリックリンクまたは通常のファイルではありません。変更しません。".into());
        }
        let mut file =
            File::open(path).map_err(|error| format!("自動起動の登録を開けません: {error}"))?;
        let opened = file
            .metadata()
            .map_err(|error| format!("自動起動の登録を確認できません: {error}"))?;
        if !opened.is_file() || opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
            return Err(
                "確認中に自動起動の登録が変更されました。操作をやり直してください。".into(),
            );
        }
        let mut contents = String::new();
        file.read_to_string(&mut contents)
            .map_err(|error| format!("自動起動の登録を読み取れません: {error}"))?;
        Ok(Some(Entry {
            contents,
            device: metadata.dev(),
            inode: metadata.ino(),
        }))
    }

    fn registered(entry: Option<&Entry>, expected: &str) -> Result<bool, String> {
        let Some(entry) = entry else {
            return Ok(false);
        };
        if entry.contents == expected {
            return Ok(true);
        }
        let owned = entry
            .contents
            .strip_prefix(PREFIX)
            .and_then(|text| text.strip_suffix(SUFFIX))
            .and_then(decode_exec);
        if owned.is_some() {
            Err("別の実行先のスレネコチェッカーが自動起動に登録されています。元の実行先で解除してから設定してください。".into())
        } else {
            Err("自動起動の登録先に所有を確認できない内容があります。上書き・削除しません。".into())
        }
    }

    fn status_at(path: &Path, executable: &Path) -> Result<bool, String> {
        registered(read_entry(path)?.as_ref(), &desktop_entry(executable)?)
    }

    fn set_at(path: &Path, executable: &Path, enabled: bool) -> Result<bool, String> {
        set_at_with(path, executable, enabled, || Ok(()))
    }

    // The callback permits deterministic failure/concurrent-change tests without global env changes.
    fn set_at_with(
        path: &Path,
        executable: &Path,
        enabled: bool,
        before_change: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        let expected = desktop_entry(executable)?;
        let original = read_entry(path)?;
        let current = registered(original.as_ref(), &expected)?;
        if current == enabled {
            return Ok(current);
        }
        if enabled {
            let parent = path
                .parent()
                .ok_or("自動起動の登録先に親ディレクトリーがありません。")?;
            fs::create_dir_all(parent)
                .map_err(|error| format!("自動起動の登録先を作成できません: {error}"))?;
            check_parents(path)?;
            let mut temporary = tempfile::Builder::new()
                .prefix(".sureneco-autostart-")
                .tempfile_in(parent)
                .map_err(|error| format!("自動起動の一時ファイルを作成できません: {error}"))?;
            temporary
                .write_all(expected.as_bytes())
                .and_then(|_| temporary.as_file().sync_all())
                .map_err(|error| format!("自動起動の登録を書き込めません: {error}"))?;
            before_change()?;
            if read_entry(path)? != original {
                return Err("確認中に自動起動の登録が変更されました。上書きしません。".into());
            }
            // Existing owned entries already match exactly; never replace any existing file.
            temporary
                .persist_noclobber(path)
                .map_err(|error| format!("自動起動の登録を保存できません: {}", error.error))?;
        } else {
            before_change()?;
            if read_entry(path)? != original {
                return Err("確認中に自動起動の登録が変更されました。削除しません。".into());
            }
            fs::remove_file(path)
                .map_err(|error| format!("自動起動の登録を削除できません: {error}"))?;
        }
        status_at(path, executable)
    }

    pub(super) fn status() -> Result<bool, String> {
        let (path, executable) = location()?;
        status_at(&path, &executable)
    }

    pub(super) fn set(enabled: bool) -> Result<bool, String> {
        let (path, executable) = location()?;
        set_at(&path, &executable, enabled)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::{symlink, PermissionsExt};

        struct Fixture {
            directory: tempfile::TempDir,
            entry: PathBuf,
            executable: PathBuf,
        }

        impl Fixture {
            fn new() -> Self {
                let directory = tempfile::tempdir().unwrap();
                let executable = directory
                    .path()
                    .join("日本語 App \"quote\" % \\ $`';.AppImage");
                fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
                let entry = directory.path().join("config/autostart/sureneco.desktop");
                Self {
                    directory,
                    entry,
                    executable,
                }
            }

            fn write_entry(&self, contents: &[u8]) {
                fs::create_dir_all(self.entry.parent().unwrap()).unwrap();
                fs::write(&self.entry, contents).unwrap();
            }
        }

        #[test]
        fn isolated_registration_roundtrip_preserves_other_applications() {
            let fixture = Fixture::new();
            assert!(!status_at(&fixture.entry, &fixture.executable).unwrap());
            assert!(!set_at(&fixture.entry, &fixture.executable, false).unwrap());
            assert!(!fixture.entry.parent().unwrap().exists());
            fs::create_dir_all(fixture.entry.parent().unwrap()).unwrap();
            let other = fixture.entry.with_file_name("other.desktop");
            fs::write(&other, "other registration").unwrap();
            assert!(set_at(&fixture.entry, &fixture.executable, true).unwrap());
            assert!(status_at(&fixture.entry, &fixture.executable).unwrap());
            assert!(set_at(&fixture.entry, &fixture.executable, true).unwrap());
            assert_eq!(
                fs::read_to_string(&fixture.entry).unwrap(),
                desktop_entry(&fixture.executable).unwrap()
            );
            assert!(!set_at(&fixture.entry, &fixture.executable, false).unwrap());
            assert!(!status_at(&fixture.entry, &fixture.executable).unwrap());
            assert!(!set_at(&fixture.entry, &fixture.executable, false).unwrap());
            assert_eq!(fs::read_to_string(other).unwrap(), "other registration");
        }

        #[test]
        fn desktop_launcher_starts_reserved_filename_without_arguments() {
            use gtk::gio::prelude::AppInfoExt;
            use std::time::{Duration, Instant};

            let fixture = Fixture::new();
            let launched = fixture.directory.path().join("launched");
            fs::write(
                &fixture.executable,
                "#!/bin/sh\ndirectory=${0%/*}\nprintf '%s\\n%s\\n' \"$0\" \"$#\" > \"$directory/launched.tmp\"\nmv -- \"$directory/launched.tmp\" \"$directory/launched\"\n",
            )
            .unwrap();
            set_at(&fixture.entry, &fixture.executable, true).unwrap();
            let application = gtk::gio::DesktopAppInfo::from_filename(&fixture.entry)
                .expect("the desktop launcher must accept the actual executable path");
            application
                .launch(&[], None::<&gtk::gio::AppLaunchContext>)
                .unwrap();
            let expected = format!("{}\n0\n", fixture.executable.display());
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match fs::read_to_string(&launched) {
                    Ok(actual) if actual == expected => break,
                    Ok(actual) if !actual.is_empty() => {
                        panic!("the desktop launcher changed the path or arguments: {actual:?}")
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(error) => panic!("cannot read launcher result: {error}"),
                }
                assert!(Instant::now() < deadline, "the executable did not run");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        #[test]
        fn conflicts_and_other_executables_are_never_overwritten_or_removed() {
            let fixture = Fixture::new();
            let other = fixture.directory.path().join("other AppImage");
            let owned = desktop_entry(&fixture.executable).unwrap();
            for contents in [
                "[Desktop Entry]\nType=Application\nExec=/bin/true\n".to_string(),
                desktop_entry(&other).unwrap(),
                format!("{owned}Hidden=true\n"),
                owned.replace("Terminal=false", "Terminal=true"),
                owned.replace("\nTerminal=false", " --hidden\nTerminal=false"),
            ] {
                fixture.write_entry(contents.as_bytes());
                assert!(status_at(&fixture.entry, &fixture.executable).is_err());
                for enabled in [true, false] {
                    assert!(set_at(&fixture.entry, &fixture.executable, enabled).is_err());
                    assert_eq!(fs::read_to_string(&fixture.entry).unwrap(), contents);
                }
            }
        }

        #[test]
        fn rejects_symlinks_in_registration_and_parent_directories() {
            let fixture = Fixture::new();
            let victim = fixture.directory.path().join("victim");
            fs::write(&victim, desktop_entry(&fixture.executable).unwrap()).unwrap();
            fs::create_dir_all(fixture.entry.parent().unwrap()).unwrap();
            symlink(&victim, &fixture.entry).unwrap();
            assert!(status_at(&fixture.entry, &fixture.executable).is_err());
            for enabled in [true, false] {
                assert!(set_at(&fixture.entry, &fixture.executable, enabled).is_err());
                assert!(fs::symlink_metadata(&fixture.entry)
                    .unwrap()
                    .file_type()
                    .is_symlink());
            }
            fs::remove_file(&fixture.entry).unwrap();
            let linked_parent = fixture.directory.path().join("linked-config");
            symlink(fixture.entry.parent().unwrap(), &linked_parent).unwrap();
            let linked_entry = linked_parent.join("sureneco.desktop");
            assert!(status_at(&linked_entry, &fixture.executable).is_err());
            assert!(set_at(&linked_entry, &fixture.executable, true).is_err());
            assert_eq!(
                fs::read_to_string(victim).unwrap(),
                desktop_entry(&fixture.executable).unwrap()
            );
        }

        #[test]
        fn read_errors_and_nonregular_entries_do_not_become_disabled() {
            let fixture = Fixture::new();
            fixture.write_entry(&[0xff]);
            assert!(status_at(&fixture.entry, &fixture.executable).is_err());
            assert!(set_at(&fixture.entry, &fixture.executable, false).is_err());
            assert_eq!(fs::read(&fixture.entry).unwrap(), [0xff]);
            fs::remove_file(&fixture.entry).unwrap();
            fs::create_dir(&fixture.entry).unwrap();
            assert!(status_at(&fixture.entry, &fixture.executable).is_err());
            assert!(set_at(&fixture.entry, &fixture.executable, true).is_err());
            assert!(fixture.entry.is_dir());
        }

        #[test]
        fn failed_changes_preserve_the_previous_registration_and_clean_temporary_files() {
            let fixture = Fixture::new();
            assert!(
                set_at_with(&fixture.entry, &fixture.executable, true, || Err(
                    "書き込み拒否".into()
                ))
                .is_err()
            );
            assert!(!fixture.entry.exists());
            assert_eq!(
                fs::read_dir(fixture.entry.parent().unwrap())
                    .unwrap()
                    .count(),
                0
            );
            set_at(&fixture.entry, &fixture.executable, true).unwrap();
            let original = fs::read(&fixture.entry).unwrap();
            assert!(
                set_at_with(&fixture.entry, &fixture.executable, false, || Err(
                    "削除拒否".into()
                ))
                .is_err()
            );
            assert_eq!(fs::read(&fixture.entry).unwrap(), original);
        }

        #[test]
        fn rechecks_ownership_and_symlinks_immediately_before_changes() {
            let fixture = Fixture::new();
            assert!(set_at_with(&fixture.entry, &fixture.executable, true, || {
                fs::write(&fixture.entry, "third-party registration").unwrap();
                Ok(())
            })
            .is_err());
            assert_eq!(
                fs::read_to_string(&fixture.entry).unwrap(),
                "third-party registration"
            );
            fixture.write_entry(desktop_entry(&fixture.executable).unwrap().as_bytes());
            assert!(set_at_with(&fixture.entry, &fixture.executable, false, || {
                fs::write(&fixture.entry, "changed registration").unwrap();
                Ok(())
            })
            .is_err());
            assert_eq!(
                fs::read_to_string(&fixture.entry).unwrap(),
                "changed registration"
            );
            fixture.write_entry(desktop_entry(&fixture.executable).unwrap().as_bytes());
            let victim = fixture.directory.path().join("victim");
            fs::write(&victim, "do not delete").unwrap();
            assert!(set_at_with(&fixture.entry, &fixture.executable, false, || {
                fs::remove_file(&fixture.entry).unwrap();
                symlink(&victim, &fixture.entry).unwrap();
                Ok(())
            })
            .is_err());
            assert_eq!(fs::read_to_string(victim).unwrap(), "do not delete");
        }

        #[test]
        fn invalid_exec_paths_field_codes_and_extra_arguments_are_rejected() {
            let path = Path::new(
                "/opt/日本語 space/quote\" percent% slash\\ dollar$ tick` apostrophe';&.AppImage",
            );
            let exec = encode_exec(path).unwrap();
            assert!(decode_exec(&format!("{exec} --hidden")).is_none());
            assert!(decode_exec("\"/opt/%f\"").is_none());
            for invalid in [
                "relative/path",
                "/opt/a\nExec=/bin/sh",
                "/opt/a\rHidden=true",
                "/opt/a\0b",
                "/opt/a=b",
            ] {
                assert!(encode_exec(Path::new(invalid)).is_err());
            }
        }

        #[test]
        fn stable_appimage_selection_validates_the_original_without_falling_back() {
            let fixture = Fixture::new();
            let mounted = Path::new("/tmp/.mount_sureneco123/usr/bin/sureneco");
            assert_eq!(
                select_executable(Some(fixture.executable.as_os_str()), mounted).unwrap(),
                fixture.executable
            );
            assert_eq!(
                select_executable(None, &fixture.executable).unwrap(),
                fixture.executable
            );
            assert!(select_executable(None, mounted).is_err());
            assert!(
                select_executable(Some(OsStr::new("relative.AppImage")), &fixture.executable)
                    .is_err()
            );
            assert!(select_executable(Some(OsStr::new("")), &fixture.executable).is_err());
            assert!(select_executable(
                Some(fixture.directory.path().join("missing").as_os_str()),
                &fixture.executable
            )
            .is_err());
            let nonexecutable = fixture.directory.path().join("not executable");
            fs::write(&nonexecutable, "data").unwrap();
            fs::set_permissions(&nonexecutable, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(
                select_executable(Some(nonexecutable.as_os_str()), &fixture.executable).is_err()
            );
            assert!(select_executable(
                Some(fixture.directory.path().as_os_str()),
                &fixture.executable
            )
            .is_err());
            let harmless = fixture.directory.path().join(".mountain");
            fs::copy(&fixture.executable, &harmless).unwrap();
            assert_eq!(select_executable(None, &harmless).unwrap(), harmless);
        }

        #[test]
        fn xdg_paths_are_absolute_and_fall_back_only_when_unspecified_or_relative() {
            assert_eq!(
                config_directory(Some(OsStr::new("/isolated/config")), None).unwrap(),
                PathBuf::from("/isolated/config")
            );
            assert_eq!(
                config_directory(None, Some(PathBuf::from("/home/test"))).unwrap(),
                PathBuf::from("/home/test/.config")
            );
            assert_eq!(
                config_directory(
                    Some(OsStr::new("relative")),
                    Some(PathBuf::from("/home/test"))
                )
                .unwrap(),
                PathBuf::from("/home/test/.config")
            );
            assert!(config_directory(None, None).is_err());
            assert!(config_directory(None, Some(PathBuf::from("relative-home"))).is_err());
            let fixture = Fixture::new();
            assert!(
                status_at(Path::new("relative/sureneco.desktop"), &fixture.executable).is_err()
            );
            assert!(status_at(
                &fixture.directory.path().join("config/../sureneco.desktop"),
                &fixture.executable
            )
            .is_err());
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::executable_text;
    use std::{
        io::ErrorKind,
        path::{Path, PathBuf},
    };
    #[cfg(test)]
    use winreg::enums::REG_EXPAND_SZ;
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ},
        types::{FromRegValue, ToRegValue},
        RegKey, RegValue,
    };

    const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const VALUE_NAME: &str = "sureneco-autostart";

    fn command(executable: &Path) -> Result<String, String> {
        let text = executable_text(executable)?;
        if text.contains('"') {
            return Err("自動起動の実行先に引用符は使用できません。".into());
        }
        Ok(format!("\"{text}\""))
    }

    fn executable() -> Result<PathBuf, String> {
        let path =
            std::env::current_exe().map_err(|error| format!("実行先を取得できません: {error}"))?;
        command(&path)?;
        if !std::fs::metadata(&path)
            .map_err(|error| format!("自動起動の実行先を確認できません: {error}"))?
            .is_file()
        {
            return Err("自動起動の実行先がファイルではありません。".into());
        }
        Ok(path)
    }

    fn read_value(key: &RegKey) -> Result<Option<RegValue>, String> {
        match key.get_raw_value(VALUE_NAME) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("自動起動の登録を読み取れません: {error}")),
        }
    }

    fn registered(value: Option<&RegValue>, expected: &RegValue) -> Result<bool, String> {
        let Some(value) = value else {
            return Ok(false);
        };
        if value == expected {
            return Ok(true);
        }
        if value.vtype == REG_SZ {
            if let Ok(text) = String::from_reg_value(value) {
                if text.to_reg_value() == *value {
                    if let Some(path) = text
                        .strip_prefix('"')
                        .and_then(|text| text.strip_suffix('"'))
                    {
                        if command(Path::new(path)).is_ok_and(|command| command == text) {
                            return Err("別の実行先のスレネコチェッカーが自動起動に登録されています。元の実行先で解除してから設定してください。".into());
                        }
                    }
                }
            }
        }
        Err("自動起動の登録先に所有を確認できない内容があります。上書き・削除しません。".into())
    }

    fn status_at(key: &RegKey, executable: &Path) -> Result<bool, String> {
        registered(
            read_value(key)?.as_ref(),
            &command(executable)?.to_reg_value(),
        )
    }

    fn set_at(key: &RegKey, executable: &Path, enabled: bool) -> Result<bool, String> {
        let expected = command(executable)?.to_reg_value();
        let original = read_value(key)?;
        let current = registered(original.as_ref(), &expected)?;
        if current == enabled {
            return Ok(current);
        }
        if read_value(key)? != original {
            return Err(
                "確認中に自動起動の登録が変更されました。操作をやり直してください。".into(),
            );
        }
        if enabled {
            key.set_raw_value(VALUE_NAME, &expected)
                .map_err(|error| format!("自動起動の登録を書き込めません: {error}"))?;
        } else {
            key.delete_value(VALUE_NAME)
                .map_err(|error| format!("自動起動の登録を削除できません: {error}"))?;
        }
        status_at(key, executable)
    }

    pub(super) fn status() -> Result<bool, String> {
        let executable = executable()?;
        match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_QUERY_VALUE) {
            Ok(key) => status_at(&key, &executable),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("自動起動の登録先を開けません: {error}")),
        }
    }

    pub(super) fn set(enabled: bool) -> Result<bool, String> {
        let executable = executable()?;
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let current = match root.open_subkey_with_flags(RUN_KEY, KEY_QUERY_VALUE) {
            Ok(key) => status_at(&key, &executable)?,
            Err(error) if error.kind() == ErrorKind::NotFound => false,
            Err(error) => return Err(format!("自動起動の登録先を開けません: {error}")),
        };
        if current == enabled {
            return Ok(current);
        }
        let key = if enabled {
            root.create_subkey_with_flags(RUN_KEY, KEY_QUERY_VALUE | KEY_SET_VALUE)
                .map(|(key, _)| key)
        } else {
            root.open_subkey_with_flags(RUN_KEY, KEY_QUERY_VALUE | KEY_SET_VALUE)
        }
        .map_err(|error| format!("自動起動の登録先を変更できません: {error}"))?;
        set_at(&key, &executable, enabled)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct Fixture {
            root: RegKey,
            subkey: String,
            key: RegKey,
            _directory: tempfile::TempDir,
        }

        impl Fixture {
            fn new() -> Self {
                let directory = tempfile::tempdir().unwrap();
                let subkey = format!(
                    "Software\\sureneco-autostart-tests\\{}-{}",
                    std::process::id(),
                    directory.path().file_name().unwrap().to_string_lossy()
                );
                let root = RegKey::predef(HKEY_CURRENT_USER);
                let (key, _) = root.create_subkey(&subkey).unwrap();
                Self {
                    root,
                    subkey,
                    key,
                    _directory: directory,
                }
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                self.root.delete_subkey_all(&self.subkey).unwrap();
            }
        }

        #[test]
        fn isolated_registry_roundtrip_keeps_other_values() {
            let fixture = Fixture::new();
            let executable = std::env::current_exe().unwrap();
            fixture
                .key
                .set_value("other-application", &"unchanged")
                .unwrap();
            assert!(!status_at(&fixture.key, &executable).unwrap());
            assert!(!set_at(&fixture.key, &executable, false).unwrap());
            assert!(set_at(&fixture.key, &executable, true).unwrap());
            assert!(status_at(&fixture.key, &executable).unwrap());
            assert!(set_at(&fixture.key, &executable, true).unwrap());
            assert_eq!(
                fixture.key.get_value::<String, _>(VALUE_NAME).unwrap(),
                format!("\"{}\"", executable.display())
            );
            assert!(!set_at(&fixture.key, &executable, false).unwrap());
            assert!(!status_at(&fixture.key, &executable).unwrap());
            assert_eq!(
                fixture
                    .key
                    .get_value::<String, _>("other-application")
                    .unwrap(),
                "unchanged"
            );
        }

        #[test]
        fn registry_conflicts_including_other_executables_and_arguments_are_preserved() {
            let fixture = Fixture::new();
            let executable = std::env::current_exe().unwrap();
            for contents in [
                "third-party command".to_string(),
                "\"C:\\other\\sureneco.exe\"".to_string(),
                format!("{} --hidden", command(&executable).unwrap()),
            ] {
                fixture.key.set_value(VALUE_NAME, &contents).unwrap();
                assert!(status_at(&fixture.key, &executable).is_err());
                for enabled in [true, false] {
                    assert!(set_at(&fixture.key, &executable, enabled).is_err());
                    assert_eq!(
                        fixture.key.get_value::<String, _>(VALUE_NAME).unwrap(),
                        contents
                    );
                }
            }
            let mut invalid_type = command(&executable).unwrap().to_reg_value();
            invalid_type.vtype = REG_EXPAND_SZ;
            fixture
                .key
                .set_raw_value(VALUE_NAME, &invalid_type)
                .unwrap();
            assert!(status_at(&fixture.key, &executable).is_err());
            assert!(set_at(&fixture.key, &executable, false).is_err());
            assert_eq!(fixture.key.get_raw_value(VALUE_NAME).unwrap(), invalid_type);
            let malformed = RegValue {
                vtype: REG_SZ,
                bytes: vec![0xff],
            };
            fixture.key.set_raw_value(VALUE_NAME, &malformed).unwrap();
            assert!(set_at(&fixture.key, &executable, true).is_err());
            assert_eq!(fixture.key.get_raw_value(VALUE_NAME).unwrap(), malformed);
        }

        #[test]
        fn registry_access_errors_preserve_existing_values() {
            let fixture = Fixture::new();
            let executable = std::env::current_exe().unwrap();
            set_at(&fixture.key, &executable, true).unwrap();
            let original = fixture.key.get_raw_value(VALUE_NAME).unwrap();
            let readonly = fixture
                .root
                .open_subkey_with_flags(&fixture.subkey, KEY_QUERY_VALUE)
                .unwrap();
            assert!(set_at(&readonly, &executable, false).is_err());
            assert_eq!(fixture.key.get_raw_value(VALUE_NAME).unwrap(), original);
            fixture.key.delete_value(VALUE_NAME).unwrap();
            assert!(set_at(&readonly, &executable, true).is_err());
            assert!(!status_at(&fixture.key, &executable).unwrap());
            let writeonly = fixture
                .root
                .open_subkey_with_flags(&fixture.subkey, KEY_SET_VALUE)
                .unwrap();
            assert!(status_at(&writeonly, &executable).is_err());
        }

        #[test]
        fn windows_command_is_one_quoted_absolute_executable_without_arguments() {
            let path = Path::new("C:\\Program Files\\日本語 %\\sureneco.exe");
            assert_eq!(
                command(path).unwrap(),
                "\"C:\\Program Files\\日本語 %\\sureneco.exe\""
            );
            for invalid in [
                "relative.exe",
                "C:\\bad\" --argument.exe",
                "C:\\bad\nname.exe",
                "C:\\bad\0name.exe",
            ] {
                assert!(command(Path::new(invalid)).is_err());
            }
        }
    }
}
