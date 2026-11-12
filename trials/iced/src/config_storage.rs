use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

use sureneco::storage::ConfigStorage;

use crate::single_instance;

/// The caller must keep the base directory's single-instance lock alive.
pub struct Storage {
    storage: ConfigStorage,
    base: PathBuf,
    active_lock: Option<File>,
}

impl Storage {
    pub fn load(base: PathBuf) -> Result<Option<Self>, String> {
        let base =
            fs::canonicalize(&base).map_err(|error| format!("{}: {error}", base.display()))?;
        let storage = ConfigStorage::load(base.clone())?;
        let active_lock = if storage.directory() == base {
            None
        } else {
            match single_instance::acquire(storage.directory())
                .map_err(|error| format!("{}: {error}", storage.directory().display()))?
            {
                Some(lock) => Some(lock),
                None => return Ok(None),
            }
        };
        Ok(Some(Self {
            storage,
            base,
            active_lock,
        }))
    }

    pub fn directory(&self) -> &Path {
        self.storage.directory()
    }

    pub fn read(&self) -> Result<Option<String>, String> {
        self.storage.read()
    }

    pub fn save(&self, text: &str) -> Result<(), String> {
        self.storage.save(text)
    }

    pub fn change(&mut self, target: &Path, text: &str) -> Result<PathBuf, String> {
        if !target.is_absolute() {
            return Err("設定保存先は絶対パスで指定してください。".into());
        }
        if target == self.directory() {
            self.storage.change(target, text)?;
            return Ok(self.directory().to_path_buf());
        }
        fs::create_dir_all(target).map_err(|error| format!("{}: {error}", target.display()))?;
        let target =
            fs::canonicalize(target).map_err(|error| format!("{}: {error}", target.display()))?;
        if target == self.directory() {
            return Ok(target);
        }
        let active_lock = if target == self.base {
            None
        } else {
            Some(
                single_instance::acquire(&target)
                    .map_err(|error| format!("{}: {error}", target.display()))?
                    .ok_or_else(|| {
                        format!(
                            "設定保存先は別のインスタンスが使用中です: {}",
                            target.display()
                        )
                    })?,
            )
        };
        self.storage.change(&target, text)?;
        // A failed copy or pointer update must retain the previous active lock.
        self.active_lock = active_lock;
        Ok(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        thread,
        time::{Duration, Instant},
    };

    // Another test's fork can inherit a just-released file descriptor until exec.
    fn eventually<T>(mut attempt: impl FnMut() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(value) = attempt() {
                return value;
            }
            assert!(Instant::now() < deadline, "lock was not released");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn released_lock(directory: &Path) -> File {
        eventually(|| single_instance::acquire(directory).unwrap())
    }

    #[test]
    fn changing_directory_preserves_old_state_and_restores_active_on_restart() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let _base_lock = single_instance::acquire(&base).unwrap().unwrap();
        let mut storage = Storage::load(base.clone()).unwrap().unwrap();
        assert_eq!(storage.read().unwrap(), None);
        storage.save("old settings and read cursors").unwrap();
        let target = root.path().join("nested/target");
        assert_eq!(
            storage
                .change(&target, "current settings and read cursors")
                .unwrap(),
            target.canonicalize().unwrap()
        );
        assert_eq!(storage.directory(), target.canonicalize().unwrap());
        assert!(single_instance::acquire(&target).unwrap().is_none());
        storage.save("saved after change\n").unwrap();
        assert_eq!(
            fs::read_to_string(base.join("state.json")).unwrap(),
            "old settings and read cursors"
        );
        drop(storage);
        assert!(single_instance::acquire(&base).unwrap().is_none());
        let restarted = eventually(|| Storage::load(base.clone()).unwrap());
        assert_eq!(restarted.directory(), target.canonicalize().unwrap());
        assert_eq!(
            restarted.read().unwrap().as_deref(),
            Some("saved after change\n")
        );
        assert!(single_instance::acquire(&target).unwrap().is_none());
    }

    #[test]
    fn busy_active_directory_is_not_loaded_and_busy_target_is_not_changed() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let target = root.path().join("target");
        let _base_lock = single_instance::acquire(&base).unwrap().unwrap();
        let mut storage = Storage::load(base.clone()).unwrap().unwrap();
        storage.save("original").unwrap();
        let target_lock = single_instance::acquire(&target).unwrap().unwrap();
        assert!(storage.change(&target, "replacement").is_err());
        assert_eq!(storage.directory(), base.canonicalize().unwrap());
        assert_eq!(storage.read().unwrap().as_deref(), Some("original"));
        assert!(!target.join("state.json").exists());
        assert!(!base.join("config-location.json").exists());
        drop(target_lock);
        let target_lock = released_lock(&target);
        fs::write(
            base.join("config-location.json"),
            serde_json::to_string(&target).unwrap(),
        )
        .unwrap();
        assert!(Storage::load(base.clone()).unwrap().is_none());
        drop(target_lock);
        let loaded = eventually(|| Storage::load(base.clone()).unwrap());
        assert_eq!(loaded.directory(), target.canonicalize().unwrap());
        assert!(single_instance::acquire(&target).unwrap().is_none());
    }

    #[test]
    fn existing_state_rejection_keeps_old_lock_and_releases_new_lock() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let active = root.path().join("active");
        let target = root.path().join("target");
        let _base_lock = single_instance::acquire(&base).unwrap().unwrap();
        let mut storage = Storage::load(base.clone()).unwrap().unwrap();
        storage.change(&active, "active state").unwrap();
        let pointer = fs::read(base.join("config-location.json")).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join("state.json"), "unrelated state").unwrap();
        assert!(storage.change(&target, "replacement").is_err());
        assert_eq!(storage.directory(), active.canonicalize().unwrap());
        assert!(single_instance::acquire(&active).unwrap().is_none());
        assert_eq!(
            fs::read(base.join("config-location.json")).unwrap(),
            pointer
        );
        assert_eq!(
            fs::read_to_string(target.join("state.json")).unwrap(),
            "unrelated state"
        );
        let _released = released_lock(&target);
        storage.save("still active").unwrap();
        assert_eq!(
            fs::read_to_string(active.join("state.json")).unwrap(),
            "still active"
        );
    }

    #[test]
    fn pointer_failure_rolls_back_state_and_retains_only_old_lock() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let active = root.path().join("active");
        let target = root.path().join("target");
        let _base_lock = single_instance::acquire(&base).unwrap().unwrap();
        let mut storage = Storage::load(base.clone()).unwrap().unwrap();
        storage.change(&active, "active state").unwrap();
        let pointer = base.join("config-location.json");
        fs::remove_file(&pointer).unwrap();
        fs::create_dir(&pointer).unwrap();
        assert!(storage.change(&target, "replacement").is_err());
        assert_eq!(storage.directory(), active.canonicalize().unwrap());
        assert_eq!(storage.read().unwrap().as_deref(), Some("active state"));
        assert!(single_instance::acquire(&active).unwrap().is_none());
        assert!(pointer.is_dir());
        assert!(!target.join("state.json").exists());
        let _released = released_lock(&target);
        storage.save("saved after failure").unwrap();
        assert_eq!(
            fs::read_to_string(active.join("state.json")).unwrap(),
            "saved after failure"
        );
    }

    #[test]
    fn successful_switch_releases_previous_active_lock() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let first = root.path().join("first");
        let second = root.path().join("second");
        let _base_lock = single_instance::acquire(&base).unwrap().unwrap();
        let mut storage = Storage::load(base).unwrap().unwrap();
        storage.change(&first, "first state").unwrap();
        storage.change(&second, "second state").unwrap();
        let _released = released_lock(&first);
        assert!(single_instance::acquire(&second).unwrap().is_none());
        assert_eq!(
            fs::read_to_string(first.join("state.json")).unwrap(),
            "first state"
        );
        drop(storage);
        let _released_second = released_lock(&second);
    }

    #[test]
    fn returning_to_empty_base_reuses_callers_lock() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let active = root.path().join("active");
        let _base_lock = single_instance::acquire(&base).unwrap().unwrap();
        let mut storage = Storage::load(base.clone()).unwrap().unwrap();
        storage.change(&active, "first state").unwrap();
        assert_eq!(
            storage.change(&base, "returned state").unwrap(),
            base.canonicalize().unwrap()
        );
        let _released = released_lock(&active);
        assert!(single_instance::acquire(&base).unwrap().is_none());
        drop(storage);
        let restarted = Storage::load(base.clone()).unwrap().unwrap();
        assert_eq!(restarted.read().unwrap().as_deref(), Some("returned state"));
        assert!(single_instance::acquire(&base).unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn aliases_are_noops_without_relocking_or_overwriting_state() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let base_alias = root.path().join("base-alias");
        let active = root.path().join("active");
        let active_alias = root.path().join("active-alias");
        let _base_lock = single_instance::acquire(&base).unwrap().unwrap();
        std::os::unix::fs::symlink(&base, &base_alias).unwrap();
        let mut storage = Storage::load(base_alias.clone()).unwrap().unwrap();
        storage.save("original").unwrap();
        storage.change(&base, "must not save").unwrap();
        storage.change(&base_alias, "must not save").unwrap();
        assert_eq!(storage.read().unwrap().as_deref(), Some("original"));
        assert!(!base.join("config-location.json").exists());
        storage.change(&active, "active state").unwrap();
        let pointer = fs::read(base.join("config-location.json")).unwrap();
        std::os::unix::fs::symlink(&active, &active_alias).unwrap();
        assert_eq!(
            storage.change(&active_alias, "must not save").unwrap(),
            active.canonicalize().unwrap()
        );
        assert_eq!(storage.read().unwrap().as_deref(), Some("active state"));
        assert_eq!(
            fs::read(base.join("config-location.json")).unwrap(),
            pointer
        );
        assert!(single_instance::acquire(&active).unwrap().is_none());
        drop(storage);
        let restarted = eventually(|| Storage::load(base_alias.clone()).unwrap());
        assert_eq!(restarted.directory(), active.canonicalize().unwrap());
    }

    #[test]
    fn invalid_paths_are_errors_instead_of_busy_results() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let _base_lock = single_instance::acquire(&base).unwrap().unwrap();
        let mut storage = Storage::load(base.clone()).unwrap().unwrap();
        storage.save("original").unwrap();
        assert!(storage
            .change(Path::new("relative"), "replacement")
            .is_err());
        let target = root.path().join("file");
        fs::write(&target, "not a directory").unwrap();
        assert!(storage.change(&target, "replacement").is_err());
        assert_eq!(storage.read().unwrap().as_deref(), Some("original"));
        let missing = root.path().join("missing");
        fs::write(
            base.join("config-location.json"),
            serde_json::to_string(&missing).unwrap(),
        )
        .unwrap();
        assert!(Storage::load(base.clone()).is_err());
        fs::create_dir(&missing).unwrap();
        fs::create_dir(missing.join(".instance.lock")).unwrap();
        assert!(Storage::load(base).is_err());
    }
}
