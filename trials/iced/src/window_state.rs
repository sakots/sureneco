use std::{
    fs,
    io::{self, BufWriter, Write},
    path::Path,
};

use iced::{window, Point, Size};
use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "window-state.json";
const MIN_WIDTH: f32 = 400.0;
const MIN_HEIGHT: f32 = 600.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub width: f32,
    pub height: f32,
    pub maximized: bool,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: 1120.0,
            height: 820.0,
            maximized: false,
        }
    }
}

impl Geometry {
    pub fn settings(&self) -> window::Settings {
        let default = Self::default();
        let width = if self.width.is_finite() {
            self.width.max(MIN_WIDTH)
        } else {
            default.width
        };
        let height = if self.height.is_finite() {
            self.height.max(MIN_HEIGHT)
        } else {
            default.height
        };
        let position = match (self.x, self.y) {
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() => {
                window::Position::Specific(Point::new(x, y))
            }
            _ => window::Position::Default,
        };
        window::Settings {
            size: Size::new(width, height),
            position,
            min_size: Some(Size::new(MIN_WIDTH, MIN_HEIGHT)),
            exit_on_close_request: false,
            ..window::Settings::default()
        }
    }

    fn validate(&self) -> Result<(), String> {
        if !self.width.is_finite()
            || !self.height.is_finite()
            || self.width < MIN_WIDTH
            || self.height < MIN_HEIGHT
        {
            return Err("ウィンドウサイズは有限値で400×600以上にしてください。".into());
        }
        match (self.x, self.y) {
            (None, None) => Ok(()),
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Ok(()),
            _ => Err("ウィンドウ位置は有限のX・Y座標を両方指定してください。".into()),
        }
    }
}

pub fn load(directory: &Path) -> Result<Option<Geometry>, String> {
    let path = directory.join(FILE_NAME);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let state: Geometry =
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    state
        .validate()
        .map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(Some(state))
}

pub fn save(directory: &Path, state: &Geometry) -> Result<(), String> {
    state.validate()?;
    let path = directory.join(FILE_NAME);
    fs::create_dir_all(directory).map_err(|error| format!("{}: {error}", directory.display()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    {
        let mut writer = BufWriter::new(temporary.as_file_mut());
        serde_json::to_writer_pretty(&mut writer, state)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        writer
            .flush()
            .map_err(|error| format!("{}: {error}", path.display()))?;
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("{}: {error}", path.display()))?;
    temporary
        .persist(&path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::{window::Position, Point, Size};

    #[test]
    fn missing_file_does_not_create_storage_or_load_monitoring_settings() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("missing");
        assert_eq!(load(&directory).unwrap(), None);
        assert!(!directory.exists());

        fs::write(root.path().join("state.json"), "not window settings").unwrap();
        assert_eq!(load(root.path()).unwrap(), None);
    }

    #[test]
    fn roundtrip_restores_negative_position_normal_size_and_maximized_state() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("nested/window");
        let state = Geometry {
            x: Some(-1920.5),
            y: Some(-40.25),
            width: 1280.25,
            height: 900.5,
            maximized: true,
        };
        save(&directory, &state).unwrap();
        let restored = load(&directory).unwrap().unwrap();
        assert_eq!(restored, state);
        let settings = restored.settings();
        assert_eq!(settings.size, Size::new(1280.25, 900.5));
        assert_eq!(
            settings.position,
            Position::Specific(Point::new(-1920.5, -40.25))
        );
    }

    #[test]
    fn minimum_size_without_position_roundtrips_and_uses_os_position() {
        let directory = tempfile::tempdir().unwrap();
        let state = Geometry {
            x: None,
            y: None,
            width: 400.0,
            height: 600.0,
            maximized: false,
        };
        save(directory.path(), &state).unwrap();
        let restored = load(directory.path()).unwrap().unwrap();
        assert_eq!(restored, state);
        assert_eq!(restored.settings().position, Position::Default);
    }

    #[test]
    fn replacing_window_state_preserves_unrelated_configuration_and_leaves_no_tempfile() {
        let directory = tempfile::tempdir().unwrap();
        let monitoring = directory.path().join("state.json");
        let location = directory.path().join("config-location.json");
        fs::write(&monitoring, "monitoring settings").unwrap();
        fs::write(&location, "configuration location").unwrap();
        save(directory.path(), &Geometry::default()).unwrap();
        let replacement = Geometry {
            x: Some(-100.0),
            y: Some(80.0),
            width: 800.0,
            height: 700.0,
            maximized: true,
        };
        save(directory.path(), &replacement).unwrap();
        assert_eq!(load(directory.path()).unwrap(), Some(replacement));
        assert_eq!(
            fs::read_to_string(monitoring).unwrap(),
            "monitoring settings"
        );
        assert_eq!(
            fs::read_to_string(location).unwrap(),
            "configuration location"
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 3);
    }

    #[test]
    fn malformed_and_invalid_files_are_errors_not_missing_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("window-state.json");
        for text in [
            "not json",
            "null",
            "[]",
            "{}",
            r#"{"width":400,"height":600,"maximized":false,"x":1,"y":null}"#,
            r#"{"width":400,"height":600,"maximized":false,"x":null,"y":1}"#,
            r#"{"width":399.999,"height":600,"maximized":false}"#,
            r#"{"width":400,"height":599.999,"maximized":false}"#,
            r#"{"width":0,"height":600,"maximized":false}"#,
            r#"{"width":400,"height":-600,"maximized":false}"#,
            r#"{"width":null,"height":600,"maximized":false}"#,
            r#"{"width":"400","height":600,"maximized":false}"#,
            r#"{"width":1e100,"height":600,"maximized":false}"#,
            r#"{"width":400,"height":1e100,"maximized":false}"#,
            r#"{"width":400,"height":600,"maximized":false,"x":1e100,"y":0}"#,
            r#"{"width":400,"height":600,"maximized":false,"x":0,"y":-1e100}"#,
            r#"{"width":NaN,"height":600,"maximized":false}"#,
            r#"{"width":400,"height":600,"maximized":"true"}"#,
        ] {
            fs::write(&path, text).unwrap();
            assert!(load(directory.path()).is_err(), "accepted {text}");
            assert_eq!(fs::read_to_string(&path).unwrap(), text);
        }
    }

    #[test]
    fn invalid_save_preserves_last_valid_file() {
        let directory = tempfile::tempdir().unwrap();
        let valid = Geometry::default();
        save(directory.path(), &valid).unwrap();
        let path = directory.path().join("window-state.json");
        let original = fs::read(&path).unwrap();
        let invalid = [
            Geometry {
                width: 399.999,
                ..valid
            },
            Geometry {
                height: 599.999,
                ..valid
            },
            Geometry {
                width: f32::NAN,
                ..valid
            },
            Geometry {
                height: f32::NAN,
                ..valid
            },
            Geometry {
                width: f32::INFINITY,
                ..valid
            },
            Geometry {
                height: f32::NEG_INFINITY,
                ..valid
            },
            Geometry {
                x: Some(1.0),
                ..valid
            },
            Geometry {
                y: Some(1.0),
                ..valid
            },
            Geometry {
                x: Some(f32::NAN),
                y: Some(0.0),
                ..valid
            },
            Geometry {
                x: Some(0.0),
                y: Some(f32::INFINITY),
                ..valid
            },
        ];
        for state in invalid {
            assert!(
                save(directory.path(), &state).is_err(),
                "accepted {state:?}"
            );
            assert_eq!(fs::read(&path).unwrap(), original);
            assert_eq!(load(directory.path()).unwrap(), Some(valid));
        }
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn filesystem_errors_are_reported_and_failed_replace_cleans_up_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("window-state.json");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep"), "untouched").unwrap();
        assert!(load(directory.path()).is_err());
        assert!(save(directory.path(), &Geometry::default()).is_err());
        assert_eq!(fs::read_to_string(path.join("keep")).unwrap(), "untouched");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);

        let not_directory = directory.path().join("file");
        fs::write(&not_directory, "untouched").unwrap();
        assert!(save(&not_directory, &Geometry::default()).is_err());
        assert_eq!(fs::read_to_string(not_directory).unwrap(), "untouched");
    }
}
