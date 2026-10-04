import { useState } from "react";
import type { Api, UpdateState } from "../core/types";
export function UpdatePanel({ api, state }: { api: Api; state: UpdateState }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    disabled: "開発実行ではアプリの更新を利用できません。",
  };
  const working =
    busy || ["checking", "downloading", "installing"].includes(state.status);
  return (
    <section className="settings-card">
      <h3>アプリの更新</h3>
      <p>現在のバージョン v{state.version}</p>
      <p role="status">{messages[state.status]}</p>
      {state.mode === "manual" && (
        <p className="help">
          この配布形式はリリース画面から手動で更新してください。
        </p>
      )}
      {(error || state.error) && (
        <p className="message error" role="alert">
          {error || state.error}
        </p>
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
          {state.mode === "auto" &&
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
          {state.mode === "auto" && state.status === "downloaded" && (
            <button
              className="primary"
              disabled={working}
              onClick={() => void act(() => api.installUpdate())}
            >
              再起動して更新
            </button>
          )}
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(() => api.openRelease())}
          >
            リリースを開く
          </button>
        </div>
      )}
    </section>
  );
}
