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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0 && !signal) {
        finish();
        return;
      }
      const detail = signal ? `シグナル: ${signal}` : `終了コード: ${code}`;
      finish(
        new Error(
          `雀魂の起動に失敗しました: ${settings.launcher_path}（${detail}）`,
        ),
      );
    };
    child.once("error", (error) => {
      finish(
        new Error(
          `雀魂の起動に失敗しました: ${settings.launcher_path}（${error.message}）`,
        ),
      );
    });
    child.once("exit", onExit);
    child.once("spawn", () => {
      child.unref();
      timer = setTimeout(() => finish(), 1000);
    });
  });
}
