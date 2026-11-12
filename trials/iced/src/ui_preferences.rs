use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preferences {
    pub dark_mode: bool,
}

impl Preferences {
    pub fn load(directory: &Path) -> Result<Self, String> {
        let path = directory.join("appearance.json");
        let contents = match fs::read(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        serde_json::from_slice(&contents).map_err(|error| format!("{}: {error}", path.display()))
    }

    pub fn save(&self, directory: &Path) -> Result<(), String> {
        let path = directory.join("appearance.json");
        fs::create_dir_all(directory).map_err(|error| format!("{}: {error}", path.display()))?;
        let mut temporary = tempfile::NamedTempFile::new_in(directory)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        serde_json::to_writer_pretty(temporary.as_file_mut(), self)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        temporary
            .flush()
            .map_err(|error| format!("{}: {error}", path.display()))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| format!("{}: {error}", path.display()))?;
        temporary
            .persist(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_changes_roundtrip_without_changing_monitoring_or_geometry() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("profile");
        assert!(!Preferences::load(&directory).unwrap().dark_mode);
        assert!(!directory.exists());
        fs::create_dir_all(&directory).unwrap();
        for name in ["state.json", "window-state.json"] {
            fs::write(directory.join(name), b"unrelated-settings").unwrap();
        }
        for dark_mode in [true, false] {
            let preferences = Preferences { dark_mode };
            preferences.save(&directory).unwrap();
            assert_eq!(Preferences::load(&directory).unwrap(), preferences);
        }
        for name in ["state.json", "window-state.json"] {
            assert_eq!(
                fs::read(directory.join(name)).unwrap(),
                b"unrelated-settings"
            );
        }
    }

    #[test]
    fn corrupt_or_unreadable_preferences_are_errors_not_silent_defaults() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("appearance.json");
        for invalid in ["{", "{}", "{\"dark_mode\":\"true\"}"] {
            fs::write(&path, invalid).unwrap();
            assert!(Preferences::load(root.path()).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
        }
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(Preferences::load(root.path()).is_err());
        assert!(Preferences { dark_mode: true }.save(root.path()).is_err());
        assert!(path.is_dir());
    }
}
