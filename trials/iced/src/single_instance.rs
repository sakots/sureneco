use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io,
    path::Path,
};

/// Keep the returned file alive for the entire application lifetime.
/// Never unlink the lock file: replacing its inode would allow a second owner.
pub fn acquire(directory: &Path) -> io::Result<Option<File>> {
    fs::create_dir_all(directory)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(".instance.lock"))?;
    match lock.try_lock() {
        Ok(()) => Ok(Some(lock)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::process::{Child, Command, Stdio};

    // A concurrent fork can briefly inherit another test's lock before exec.
    static PROCESS_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn lock_lifetime_and_independent_directories() {
        let _serial = PROCESS_TEST.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("profile");
        let owner = acquire(&directory).unwrap().unwrap();
        assert!(acquire(&directory).unwrap().is_none());
        let independent = acquire(&root.path().join("other")).unwrap().unwrap();
        drop(owner);
        let restarted = acquire(&directory).unwrap().unwrap();
        assert!(acquire(&directory).unwrap().is_none());
        drop((restarted, independent));
        assert!(directory.join(".instance.lock").exists());
        assert!(acquire(&directory).unwrap().is_some());
    }

    #[test]
    fn filesystem_errors_are_not_reported_as_another_instance() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("not-a-directory");
        std::fs::write(&directory, b"unchanged").unwrap();
        assert!(acquire(&directory).is_err());
        assert_eq!(std::fs::read(directory).unwrap(), b"unchanged");
    }

    struct ChildGuard(Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn another_process_is_excluded_and_crash_releases_lock() {
        const CHILD_DIRECTORY: &str = "SURENECO_INSTANCE_TEST_CHILD_DIRECTORY";
        if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
            let _owner = acquire(std::path::Path::new(&directory)).unwrap().unwrap();
            println!("INSTANCE_READY");
            std::io::stdout().flush().unwrap();
            let _ = std::io::stdin().read_exact(&mut [0]);
            return;
        }
        let _serial = PROCESS_TEST.lock().unwrap();

        let root = tempfile::tempdir().unwrap();
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "single_instance::tests::another_process_is_excluded_and_crash_releases_lock",
                    "--nocapture",
                    "--quiet",
                ])
                .env(CHILD_DIRECTORY, root.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let output = BufReader::new(child.0.stdout.take().unwrap());
        assert!(output.lines().any(|line| line.unwrap() == "INSTANCE_READY"));
        assert!(acquire(root.path()).unwrap().is_none());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let _restarted = acquire(root.path()).unwrap().unwrap();
        assert!(acquire(root.path()).unwrap().is_none());
    }
}
