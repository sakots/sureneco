import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { clipboard, shell } from "electron";
import { normalizeRoomId } from "../core/room-id";
import type { Settings } from "../core/types";

const gameUrl = "https://game.mahjongsoul.com/";

export async function launchMahjongSoul(
  input: unknown,
  settings: Settings,
): Promise<void> {
  const roomId = normalizeRoomId(input);
  clipboard.writeText(roomId);
  if (settings.launcher_mode === "default") {
    await shell.openExternal(gameUrl);
    return;
  }
  const args =
    settings.launcher_mode === "browser"
      ? [
          ...(settings.launcher_profile
            ? [`--profile-directory=${settings.launcher_profile}`]
            : []),
          ...(settings.launcher_user_data_dir
            ? [`--user-data-dir=${settings.launcher_user_data_dir}`]
            : []),
          gameUrl,
        ]
      : settings.launcher_args;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(settings.launcher_path, args, {
      cwd: dirname(settings.launcher_path),
      shell: false,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
