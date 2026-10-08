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

pub fn read(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

pub fn write(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("保存先が不正です。")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
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
}
