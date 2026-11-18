import { useState } from "react";
import type { Api, UpdateState } from "../core/types";
import { DismissibleMessage } from "./DismissibleMessage";
export function UpdatePanel({ api, state }: { api: Api; state: UpdateState }) {
  const [error, setError] = useState("");
  const [errorGeneration, setErrorGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [apkBlocked, setApkBlocked] = useState(false);
  const mobile = !!api.mobile;
  async function act(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
      setApkBlocked(false);
    } catch (err) {
      setApkBlocked(true);
      setError(err instanceof Error ? err.message : String(err));
      setErrorGeneration((generation) => generation + 1);
    } finally {
      setBusy(false);
    }
  }
  const messages: Record<UpdateState["status"], string> = {
    idle: "GitHubの最新リリースを確認できます。",
    checking: "更新を確認中…",
    current: "最新バージョンです。",
    available: `v${state.latestVersion}が公開されています。`,
    downloading: `ダウンロード中 ${state.progress}%`,
    downloaded: `v${state.latestVersion}の準備ができました。`,
    installing: "更新を適用しています…",
    error: "更新処理に失敗しました。再試行できます。",
    disabled: mobile
      ? "Play版と開発用APKはGitHubからの更新案内の対象外です。"
      : "開発実行ではアプリの更新を利用できません。",
  };
  const working =
    busy || ["checking", "downloading", "installing"].includes(state.status);
  const displayError = error || state.error;
  return (
    <section className="settings-card">
      <h3>アプリの更新</h3>
      <p>現在のバージョン v{state.version}</p>
      <p role="status">{messages[state.status]}</p>
      {state.mode === "manual" && (
        <p className="help">
          {mobile
            ? "APKをブラウザーで開き、Androidの確認画面から更新してください。インストールには利用者の操作が必要です。同じ署名のAPKなら設定を保持します。"
            : "この配布形式はリリース画面から手動で更新してください。"}
        </p>
      )}
      {displayError && (
        <DismissibleMessage
          key={errorGeneration}
          message={displayError}
          tone="error"
          onDismiss={() => setError("")}
        />
      )}
      {state.status === "downloading" && (
        <progress
          max={100}
          value={state.progress}
          aria-label="更新のダウンロード進捗"
        />
      )}
      {state.mode !== "disabled" && (
        <div className="update-actions">
          <button
            className="secondary"
            disabled={working || state.status === "downloaded"}
            onClick={() => void act(() => api.checkUpdate())}
          >
            更新を確認
          </button>
          {!mobile &&
            state.mode === "auto" &&
            state.latestVersion &&
            ["available", "error"].includes(state.status) && (
              <button
                className="primary"
                disabled={working}
                onClick={() => void act(() => api.downloadUpdate())}
              >
                ダウンロード
              </button>
            )}
          {!mobile &&
            state.mode === "auto" &&
            state.status === "downloaded" && (
              <button
                className="primary"
                disabled={working}
                onClick={() => void act(() => api.installUpdate())}
              >
                再起動して更新
              </button>
            )}
          {(!mobile ||
            (state.mode === "manual" &&
              state.status === "available" &&
              !apkBlocked &&
              !displayError)) && (
            <button
              className="secondary"
              disabled={mobile ? working : busy}
              onClick={() => void act(() => api.openRelease())}
            >
              {mobile ? "APKをダウンロード" : "リリースを開く"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
