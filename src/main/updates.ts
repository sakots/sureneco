import type { UpdateState } from "../core/types";
import { errorMessage } from "../core/monitor";
interface Engine {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}
export const releaseUrl = "https://github.com/sakots/sureneco/releases/latest";
export function updateMode(
  packaged: boolean,
  platform: string,
  packageType: string,
  appImage: boolean,
): UpdateState["mode"] {
  if (!packaged) return "disabled";
  if (
    (platform === "win32" && packageType === "nsis") ||
    (platform === "linux" && (appImage || packageType === "deb"))
  )
    return "auto";
  return "manual";
}
export class UpdateManager {
  private state: UpdateState;
  private notified = new Set<string>();
  private checking = false;
  private downloading = false;
  onChange: (state: UpdateState) => void = () => {};
  constructor(
    private engine: Engine,
    version: string,
    mode: UpdateState["mode"],
    notify: (version: string) => void,
  ) {
    this.state = {
      version,
      mode,
      status: mode === "disabled" ? "disabled" : "idle",
      latestVersion: null,
      progress: 0,
      error: null,
    };
    engine.autoDownload = false;
    engine.autoInstallOnAppQuit = false;
    engine.allowPrerelease = false;
    engine.allowDowngrade = false;
    engine.on("update-available", (info: { version: string }) => {
      if (mode === "disabled") return;
      this.set({
        status: "available",
        latestVersion: info.version,
        error: null,
      });
      if (!this.notified.has(info.version)) {
        this.notified.add(info.version);
        try {
          notify(info.version);
        } catch {
          /* OS通知失敗でも更新処理を継続する。 */
        }
      }
    });
    engine.on("update-not-available", () =>
      this.set({ status: "current", error: null, latestVersion: null }),
    );
    engine.on("download-progress", (info: { percent: number }) =>
      this.set({
        progress: Math.max(0, Math.min(100, Math.round(info.percent))),
      }),
    );
    engine.on("update-downloaded", (info: { version: string }) =>
      this.set({
        status: "downloaded",
        latestVersion: info.version,
        progress: 100,
        error: null,
      }),
    );
    engine.on("error", (error: unknown) =>
      this.set({ status: "error", error: errorMessage(error) }),
    );
  }
  snapshot(): UpdateState {
    return { ...this.state };
  }
  private set(patch: Partial<UpdateState>) {
    if (this.state.mode === "disabled") return;
    Object.assign(this.state, patch);
    this.onChange(this.snapshot());
  }
  async check(): Promise<void> {
    if (
      this.checking ||
      this.downloading ||
      this.state.mode === "disabled" ||
      ["checking", "downloading", "downloaded", "installing"].includes(
        this.state.status,
      )
    )
      return;
    this.checking = true;
    this.set({ status: "checking", error: null });
    try {
      await this.engine.checkForUpdates();
    } catch (error) {
      this.set({ status: "error", error: errorMessage(error) });
    } finally {
      this.checking = false;
      if (this.state.status === "checking") this.set({ status: "idle" });
    }
  }
  async download(): Promise<void> {
    if (this.state.mode !== "auto")
      throw new Error("この配布形式は手動更新してください。");
    if (
      this.downloading ||
      ["downloading", "downloaded", "installing"].includes(this.state.status)
    )
      return;
    if (
      !this.state.latestVersion ||
      !["available", "error"].includes(this.state.status)
    )
      throw new Error("ダウンロードできる更新がありません。");
    this.downloading = true;
    this.set({ status: "downloading", progress: 0, error: null });
    try {
      await this.engine.downloadUpdate();
    } catch (error) {
      this.set({ status: "error", error: errorMessage(error) });
    } finally {
      this.downloading = false;
    }
  }
  install(): void {
    if (this.state.mode !== "auto" || this.state.status !== "downloaded")
      throw new Error("取得済みの更新がありません。");
    this.set({ status: "installing", error: null });
    try {
      this.engine.quitAndInstall(false, true);
    } catch (error) {
      this.set({ status: "error", error: errorMessage(error) });
    }
  }
}
