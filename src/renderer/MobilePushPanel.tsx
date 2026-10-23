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
        画面を閉じている間の通知には、中継アプリのntfyが必要です。
        通知は1分程度を目標に届けます。通信や電池設定で遅れる場合があります。
      </p>
      <details className="ntfy-help">
        <summary>ntfyの準備・設定手順</summary>
        <p>
          ntfy（エヌティファイ）は、通知サーバーとの接続を保ち、スレネコチェッカーへ通知を届ける無料の中継アプリです。
          スレネコチェッカーと同じスマホへインストールしてください。
        </p>
        <ol>
          <li>
            <strong>ntfyをインストールする</strong>
            <p>
              Google
              PlayまたはF-Droidで「ntfy」を検索してインストールし、一度開きます。
              どちらの配布版も利用できます。
            </p>
            <p>
              このアプリで設定する自前サーバーへの通知では、Google
              Play版でもFirebaseを使いません。
              F-Droid版はFirebaseの機能自体を含まない配布版です。
            </p>
          </li>
          <li>
            <strong>通知サーバーを設定する</strong>
            <p>
              ntfyの「︙」→「設定」→「一般」→「デフォルトのサーバー」を開き、次のURLを保存します。
              項目名はntfyのバージョンによって多少異なります。
            </p>
            {state?.ntfyOrigin ? (
              <p>
                接続先：<code>{state.ntfyOrigin}</code>
              </p>
            ) : (
              <p>
                通知サーバーの接続先が未設定です。アプリの配布元へ確認してください。
              </p>
            )}
          </li>
          <li>
            <strong>端末用アカウントを登録する</strong>
            <p>
              ntfyの「設定」→「ユーザー管理」→「ユーザー追加」を開きます。
              サーバーURLには上記と同じ接続先を、ユーザー名・パスワードには運用者から案内された端末用アカウントの情報を入力して保存します。
              アカウントがまだない場合は運用者へ発行を依頼してください。
            </p>
          </li>
          <li>
            <strong>権限とバックグラウンド動作を確認する</strong>
            <p>
              ntfyの「設定」→「詳細設定」→「UnifiedPushを有効化する」をオンにします。
              UnifiedPushはアプリへ通知を中継する仕組みです。
              ntfyとスレネコチェッカーの通知を許可し、ntfyの案内に従ってバッテリー最適化の対象から除外してください。
              ntfyの常駐通知が表示されることがあります。ntfyを強制停止すると通知が届かなくなる場合があります。
            </p>
          </li>
          <li>
            <strong>この画面で通知を有効にする</strong>
            <p>
              スレネコチェッカーへ戻り、保存内容への同意を選び、「通知を有効にする」を押します。
              中継アプリの選択が表示されたらntfyを選びます。通知用のトピック（受信先）はこの操作で作成されます。
            </p>
          </li>
        </ol>
        <p>
          <strong>確認待ち・同期失敗が続く場合</strong>
        </p>
        <p>
          接続先と端末用アカウントを確認してください。初回は、運用者が端末専用トピックの読み取り権限を設定する必要があります。
          ntfyに表示されるスレネコチェッカー用のトピックを運用者へ伝えて設定を依頼し、ntfyの接続を再試行してください。
          確認の再送には最短60秒の間隔があるため、1分ほど待ってから下の「同期を再試行」を押します。
          「監視中」になったことを確認してください。
        </p>
      </details>
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
