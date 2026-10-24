import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

// Run explicitly with sudo; the caller retrieves this file over SSH and removes it.
const source = "/etc/sureneco-backup/password";
const target = "/home/sureneco/sureneco-backup-recovery.password";
try {
  if (process.getuid?.() !== 0) throw new Error("root_required");
  const stat = fs.lstatSync(source);
  if (
    !stat.isFile() ||
    stat.uid !== 0 ||
    stat.gid !== 0 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size !== 65
  )
    throw new Error("unsafe_password_file");
  const password = fs.readFileSync(source);
  if (!/^[a-f0-9]{64}\n$/.test(password.toString("ascii")))
    throw new Error("unexpected_password_format");
  const uid = Number(
    execFileSync("/usr/bin/id", ["-u", "sureneco"], {
      encoding: "utf8",
    }).trim(),
  );
  const gid = Number(
    execFileSync("/usr/bin/id", ["-g", "sureneco"], {
      encoding: "utf8",
    }).trim(),
  );
  const home = fs.lstatSync("/home/sureneco");
  if (!home.isDirectory() || home.uid !== uid || uid === 0)
    throw new Error("unexpected_home_owner");
  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, password);
    fs.fsyncSync(fd);
    fs.fchownSync(fd, uid, gid);
  } finally {
    password.fill(0);
    fs.closeSync(fd);
  }
  console.log(
    "Recovery export created with owner-only access. Retrieve over SSH, then remove: " +
      target,
  );
} catch (error) {
  console.error(
    /^[a-z_]+$/.test(error.message)
      ? error.message
      : "recovery_export_failed_no_overwrite",
  );
  process.exitCode = 1;
}
