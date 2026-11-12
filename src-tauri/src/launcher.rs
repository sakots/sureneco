use serde_json::Value;
use std::{
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const GAME_URL: &str = "https://game.mahjongsoul.com/";

pub fn launch(settings: &Value) -> Result<(), String> {
    let mode = settings["launcher_mode"].as_str().unwrap_or("default");
    if mode == "default" {
        return open::that(GAME_URL).map_err(|e| e.to_string());
    }
    let path = settings["launcher_path"]
        .as_str()
        .ok_or("実行ファイルが不正です。")?;
    spawn_application(path, launcher_arguments(settings)?)
}

fn launcher_arguments(settings: &Value) -> Result<Vec<String>, String> {
    let mode = settings["launcher_mode"].as_str().unwrap_or("application");
    let mut args: Vec<String> = Vec::new();
    if mode == "browser" {
        for (key, flag) in [
            ("launcher_profile", "--profile-directory="),
            ("launcher_user_data_dir", "--user-data-dir="),
        ] {
            if let Some(value) = settings[key].as_str().filter(|v| !v.is_empty()) {
                args.push(format!("{flag}{value}"));
            }
        }
        args.push(GAME_URL.into());
    } else {
        args =
            serde_json::from_value(settings["launcher_args"].clone()).map_err(|e| e.to_string())?;
    }
    Ok(args)
}

fn spawn_application(path: &str, args: Vec<String>) -> Result<(), String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(parent) = std::path::Path::new(path).parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008 | 0x00000200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("雀魂の起動に失敗しました: {path}（{e}）"))?;
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if status.success() {
                return Ok(());
            }
            return Err(format!("雀魂の起動に失敗しました: {path}（{status}）"));
        }
        thread::sleep(Duration::from_millis(25));
    }
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_browser_profile_and_application_arguments() {
        assert_eq!(launcher_arguments(&json!({"launcher_mode":"browser", "launcher_profile":"Profile 1", "launcher_user_data_dir":"/home/example/Browser Data"})).unwrap(), vec!["--profile-directory=Profile 1", "--user-data-dir=/home/example/Browser Data", "https://game.mahjongsoul.com/"]);
        assert_eq!(launcher_arguments(&json!({"launcher_mode":"application", "launcher_args":["-applaunch", "12345", "an argument with spaces"]})).unwrap(), vec!["-applaunch", "12345", "an argument with spaces"]);
    }
    #[cfg(unix)]
    #[test]
    fn launches_without_shell_interpretation_and_reports_early_failure() {
        use std::{fs, os::unix::fs::PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("launcher with spaces");
        let output = directory.path().join("args");
        fs::write(
            &executable,
            "#!/bin/sh\nout=$1\nshift\nprintf '%s\\n' \"$@\" > \"$out\"\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        spawn_application(
            executable.to_str().unwrap(),
            vec![
                output.to_string_lossy().into(),
                "an argument with spaces".into(),
                "$(do-not-run)".into(),
            ],
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(output).unwrap(),
            "an argument with spaces\n$(do-not-run)\n"
        );
        assert!(
            spawn_application("/bin/sh", vec!["-c".into(), "exit 7".into()])
                .unwrap_err()
                .contains("7")
        );
        assert!(spawn_application("/missing/sureneco-launcher", vec![]).is_err());
    }
}
