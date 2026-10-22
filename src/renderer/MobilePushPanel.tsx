import { useEffect, useState } from "react";
import type { PushApi, PushState } from "../core/types";
export function MobilePushPanel({ api }: { api: PushApi }) {
  const [state, setState] = useState<PushState | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const read = () => {
      if (!document.hidden)
        void api
          .getPushState()
          .then((s) => {
            if (alive) setState(s);
          })
          .catch(() => {
            if (alive) setError("通知状態を確認できません。");
          });
    };
    read();
    const timer = setInterval(read, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api]);
  async function act(fn: () => Promise<PushState>) {
    setBusy(true);
    setError("");
    try {
      setState(await fn());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card" aria-label="バックグラウンド通知">
      <h3>バックグラウンド通知</h3>
      <p role="status">{state?.status ?? "確認中…"}</p>
      <p>
        ntfyアプリを導入し、{state?.ntfyOrigin || "自前ntfyサーバー"}
        を設定してください。通知は1分程度を目標に届けます。通信や電池設定で遅れる場合があります。
      </p>
      <p className="help">
        監視条件・監視スレッド・端末識別・暗号化用の通知先情報をサーバーに保存します。通知履歴は期限後に削除し、設定は登録削除まで保存します。通知の停止・登録削除は下のボタンから行えます。
      </p>
      <label>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        保存内容と通知方式に同意する
      </label>
      {error && <p role="alert">{error}</p>}
      {state?.server && (
        <p className="metadata">
          直近に確認したサーバー状態：
          {state.server.lastFetchSuccessAt
            ? new Date(state.server.lastFetchSuccessAt).toLocaleString()
            : "取得未確認"}{" "}
          {state.server.error ?? state.server.delivery?.error}
        </p>
      )}
      <div className="form-actions">
        {!state?.permission && (
          <button
            disabled={busy}
            onClick={() => {
              void api
                .requestPushPermission()
                .catch(() => setError("通知権限を確認してください。"));
            }}
          >
            通知を許可
          </button>
        )}
        <button
          disabled={busy || !consent || !state?.permission}
          onClick={() => void act(() => api.startPush(true))}
        >
          通知を有効にする
        </button>
        <button disabled={busy} onClick={() => void act(() => api.syncPush())}>
          同期を再試行
        </button>
        <button disabled={busy} onClick={() => void act(() => api.stopPush())}>
          監視を停止
        </button>
        <button
          disabled={busy}
          onClick={() => void act(() => api.deletePush())}
        >
          サーバー登録を削除
        </button>
      </div>
    </section>
  );
}
