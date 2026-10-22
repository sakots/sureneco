use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

pub fn directory() -> Result<PathBuf, String> {
    // Electronのapp.getPath("userData")と同じ保存先。
    let base = dirs::config_dir();
    base.map(|path| path.join("sureneco"))
        .ok_or_else(|| "設定ディレクトリーを取得できません。".into())
}

pub struct ConfigStorage {
    base: PathBuf,
    directory: PathBuf,
    custom_directory: bool,
}

impl ConfigStorage {
    pub fn load(base: PathBuf) -> Result<Self, String> {
        let (directory, custom_directory) = match read(&base.join("config-location.json"))? {
            Some(text) => {
                let path: String = serde_json::from_str(&text)
                    .map_err(|error| format!("設定保存先の情報が不正です: {error}"))?;
                let path = PathBuf::from(path);
                if !path.is_absolute() {
                    return Err("設定保存先は絶対パスで指定してください。".into());
                }
                fs::read_dir(&path).map_err(|error| format!("{}: {error}", path.display()))?;
                let directory = fs::canonicalize(&path)
                    .map_err(|error| format!("{}: {error}", path.display()))?;
                (directory, true)
            }
            None => (base.clone(), false),
        };
        Ok(Self {
            base,
            directory,
            custom_directory,
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn read(&self) -> Result<Option<String>, String> {
        if self.custom_directory {
            fs::read_dir(&self.directory)
                .map_err(|error| format!("{}: {error}", self.directory.display()))?;
        }
        read(&self.directory.join("state.json"))
    }

    pub fn save(&self, text: &str) -> Result<(), String> {
        let state = self.directory.join("state.json");
        if self.custom_directory {
            write_existing(&state, text)
        } else {
            write(&state, text)
        }
    }

    pub fn change(&mut self, directory: &Path, text: &str) -> Result<(), String> {
        if !directory.is_absolute() {
            return Err("設定保存先は絶対パスで指定してください。".into());
        }
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        let directory = fs::canonicalize(directory).map_err(|error| error.to_string())?;
        if directory == self.directory
            || fs::canonicalize(&self.directory).is_ok_and(|active| active == directory)
        {
            return Ok(());
        }

        let pointer = serde_json::to_string(&directory).map_err(|error| error.to_string())?;
        let state = directory.join("state.json");
        let mut temp =
            tempfile::NamedTempFile::new_in(&directory).map_err(|error| error.to_string())?;
        temp.write_all(text.as_bytes())
            .map_err(|error| error.to_string())?;
        temp.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        temp.persist_noclobber(&state)
            .map_err(|error| format!("{}: {error}", state.display()))?;

        if let Err(error) = write(&self.base.join("config-location.json"), &pointer) {
            fs::remove_file(&state).map_err(|rollback| {
                format!("{error}\nコピーした設定ファイルの削除に失敗しました: {rollback}")
            })?;
            return Err(error);
        }
        self.directory = directory;
        self.custom_directory = true;
        Ok(())
    }
}

pub fn read(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

pub(crate) fn write(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("保存先が不正です。")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    write_existing(path, text)
}

fn write_existing(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("保存先が不正です。")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temp.write_all(text.as_bytes())
        .map_err(|error| error.to_string())?;
    temp.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temp.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_and_atomic_replace() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/state.json");
        assert_eq!(read(&path).unwrap(), None);
        write(&path, "first").unwrap();
        write(&path, "second").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("second"));
    }

    #[test]
    fn default_directory_and_save() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let storage = ConfigStorage::load(base.clone()).unwrap();
        assert_eq!(storage.directory(), base);
        assert_eq!(storage.read().unwrap(), None);
        storage.save("settings and watch cursors").unwrap();
        assert_eq!(
            read(&base.join("state.json")).unwrap().as_deref(),
            Some("settings and watch cursors")
        );
        assert!(!base.join("config-location.json").exists());
    }

    #[test]
    fn change_persists_snapshot_and_restart_destination() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let target = root.path().join("new/nested");
        let mut storage = ConfigStorage::load(base.clone()).unwrap();
        storage.save("original").unwrap();
        storage
            .change(&target, "current settings and cursors")
            .unwrap();
        let target = target.canonicalize().unwrap();
        assert_eq!(storage.directory(), target);
        assert_eq!(
            read(&base.join("state.json")).unwrap().as_deref(),
            Some("original")
        );
        assert_eq!(
            storage.read().unwrap().as_deref(),
            Some("current settings and cursors")
        );
        let pointer: String =
            serde_json::from_str(&read(&base.join("config-location.json")).unwrap().unwrap())
                .unwrap();
        assert_eq!(PathBuf::from(pointer), target);
        storage.save("saved after change").unwrap();
        let restarted = ConfigStorage::load(base.clone()).unwrap();
        assert_eq!(restarted.directory(), target);
        assert_eq!(
            restarted.read().unwrap().as_deref(),
            Some("saved after change")
        );
        restarted.save("saved after restart").unwrap();
        assert_eq!(
            read(&target.join("state.json")).unwrap().as_deref(),
            Some("saved after restart")
        );
        assert_eq!(
            read(&base.join("state.json")).unwrap().as_deref(),
            Some("original")
        );
    }

    #[test]
    fn existing_target_state_is_preserved_and_rejected() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let target = root.path().join("target");
        let mut storage = ConfigStorage::load(base.clone()).unwrap();
        storage.save("original").unwrap();
        write(&target.join("state.json"), "existing target").unwrap();
        assert!(storage.change(&target, "replacement").is_err());
        assert_eq!(storage.directory(), base);
        assert_eq!(storage.read().unwrap().as_deref(), Some("original"));
        assert_eq!(
            read(&target.join("state.json")).unwrap().as_deref(),
            Some("existing target")
        );
        assert!(!base.join("config-location.json").exists());
    }

    #[test]
    fn existing_target_state_directory_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let target = root.path().join("target");
        fs::create_dir_all(target.join("state.json")).unwrap();
        let mut storage = ConfigStorage::load(base.clone()).unwrap();
        assert!(storage.change(&target, "replacement").is_err());
        assert_eq!(storage.directory(), base);
        assert!(target.join("state.json").is_dir());
        assert!(!base.join("config-location.json").exists());
    }

    #[test]
    fn same_directory_is_a_no_op() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let mut storage = ConfigStorage::load(base.clone()).unwrap();
        storage.save("original").unwrap();
        storage.change(&base.join("."), "replacement").unwrap();
        assert_eq!(storage.directory(), base);
        assert_eq!(storage.read().unwrap().as_deref(), Some("original"));
        assert!(!base.join("config-location.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn same_directory_symlink_is_a_no_op() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let alias = root.path().join("alias");
        let mut storage = ConfigStorage::load(base.clone()).unwrap();
        storage.save("original").unwrap();
        std::os::unix::fs::symlink(&base, &alias).unwrap();
        storage.change(&alias, "replacement").unwrap();
        assert_eq!(storage.directory(), base);
        assert_eq!(storage.read().unwrap().as_deref(), Some("original"));
        assert!(!base.join("config-location.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn dangling_target_state_symlink_is_preserved_and_rejected() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let target = root.path().join("target");
        fs::create_dir_all(&target).unwrap();
        let missing = root.path().join("missing");
        std::os::unix::fs::symlink(&missing, target.join("state.json")).unwrap();
        let mut storage = ConfigStorage::load(base.clone()).unwrap();
        assert!(storage.change(&target, "replacement").is_err());
        assert_eq!(storage.directory(), base);
        assert_eq!(fs::read_link(target.join("state.json")).unwrap(), missing);
        assert!(!base.join("config-location.json").exists());
    }

    #[test]
    fn invalid_directory_paths_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let mut storage = ConfigStorage::load(base.clone()).unwrap();
        storage.save("original").unwrap();
        assert!(storage
            .change(Path::new("relative"), "replacement")
            .is_err());
        assert!(storage.change(Path::new(""), "replacement").is_err());
        let file = root.path().join("file");
        fs::write(&file, "not a directory").unwrap();
        assert!(storage.change(&file, "replacement").is_err());
        assert_eq!(storage.directory(), base);
        assert_eq!(storage.read().unwrap().as_deref(), Some("original"));
        assert!(!base.join("config-location.json").exists());
    }

    #[test]
    fn malformed_and_relative_pointers_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        for pointer in ["not json", "null", "{}", "[]", "\"relative\"", "\"\""] {
            write(&base.join("config-location.json"), pointer).unwrap();
            assert!(ConfigStorage::load(base.clone()).is_err(), "{pointer}");
        }
    }

    #[test]
    fn unavailable_custom_directories_are_rejected_on_load() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let missing = root.path().join("missing");
        let file = root.path().join("file");
        fs::write(&file, "not a directory").unwrap();
        for target in [&missing, &file] {
            let pointer = serde_json::to_string(target).unwrap();
            write(&base.join("config-location.json"), &pointer).unwrap();
            assert!(ConfigStorage::load(base.clone()).is_err());
        }
        assert!(!missing.exists());
    }

    #[test]
    fn removed_custom_directory_is_not_recreated_by_save() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let target = root.path().join("target");
        let mut storage = ConfigStorage::load(base.clone()).unwrap();
        storage.change(&target, "current").unwrap();
        fs::remove_file(target.join("state.json")).unwrap();
        fs::remove_dir(&target).unwrap();
        assert!(storage.read().is_err());
        assert!(storage.save("replacement").is_err());
        assert!(ConfigStorage::load(base).is_err());
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn loaded_custom_directory_symlink_is_canonicalized() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let target = root.path().join("target");
        let alias = root.path().join("alias");
        fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        let pointer = serde_json::to_string(&alias).unwrap();
        write(&base.join("config-location.json"), &pointer).unwrap();
        let mut storage = ConfigStorage::load(base.clone()).unwrap();
        assert_eq!(storage.directory(), target.canonicalize().unwrap());
        storage.change(&alias, "no-op").unwrap();
        assert!(!target.join("state.json").exists());
        assert_eq!(
            read(&base.join("config-location.json")).unwrap().as_deref(),
            Some(pointer.as_str())
        );
    }

    #[test]
    fn pointer_failure_rolls_back_new_state_and_keeps_active_destination() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("default");
        let target = root.path().join("target");
        let mut storage = ConfigStorage::load(base.clone()).unwrap();
        storage.save("original").unwrap();
        let pointer = base.join("config-location.json");
        fs::create_dir(&pointer).unwrap();
        assert!(storage.change(&target, "replacement").is_err());
        assert_eq!(storage.directory(), base);
        assert_eq!(storage.read().unwrap().as_deref(), Some("original"));
        assert!(pointer.is_dir());
        assert!(fs::symlink_metadata(target.join("state.json")).is_err());
        storage.save("saved after failed change").unwrap();
        assert_eq!(
            read(&base.join("state.json")).unwrap().as_deref(),
            Some("saved after failed change")
        );
        assert!(fs::symlink_metadata(target.join("state.json")).is_err());
    }
}
