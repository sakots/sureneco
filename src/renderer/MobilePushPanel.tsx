import { useEffect, useRef, useState } from "react";
import type { PushApi, PushState } from "../core/types";
export function MobilePushPanel({ api }: { api: PushApi }) {
  const [state, setState] = useState<PushState | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  const actionInFlight = useRef(false);
  const [revealedFor, setRevealedFor] = useState<PushState | null>(null);
  const registration = state?.registration;
  const passwordVisible =
    revealedFor !== null &&
    revealedFor.ntfyOrigin === state?.ntfyOrigin &&
    revealedFor.enabled === state?.enabled &&
    revealedFor.status === state?.status &&
    revealedFor.pendingAction === state?.pendingAction &&
    revealedFor.registration?.topic === registration?.topic &&
    revealedFor.registration?.username === registration?.username &&
    revealedFor.registration?.password === registration?.password &&
    revealedFor.registration?.state === registration?.state &&
    revealedFor.registration?.error === registration?.error;
  useEffect(() => {
    setRevealedFor(null);
  }, [
    state?.ntfyOrigin,
    state?.enabled,
    state?.status,
    state?.pendingAction,
    registration?.topic,
    registration?.username,
    registration?.password,
    registration?.state,
    registration?.error,
  ]);
  useEffect(() => {
    let alive = true;
    const read = () => {
      if (document.hidden || actionInFlight.current) return;
      const requestVersion = ++version.current;
      void api
        .getPushState()
        .then((s) => {
          if (alive && requestVersion === version.current) setState(s);
        })
        .catch(() => {
          if (alive && requestVersion === version.current)
            setError("通知状態を確認できません。");
        });
    };
    read();
    const timer = setInterval(read, 5000);
    return () => {
      alive = false;
      ++version.current;
      actionInFlight.current = false;
      clearInterval(timer);
    };
  }, [api]);
  async function act(
    fn: () => Promise<PushState>,
    pendingAction?: "stop" | "delete",
  ) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    const requestVersion = ++version.current;
    setBusy(true);
    setError("");
    if (pendingAction) {
      setState((previous) => ({
        ...previous,
        permission: previous?.permission ?? false,
        enabled: false,
        status: "端末の通知を停止しました。",
        pendingAction,
      }));
    }
    try {
      const next = await fn();
      if (requestVersion === version.current) setState(next);
    } catch {
      if (requestVersion === version.current)
        setError(
          "通知設定を変更できません。接続を確認して再試行してください。",
        );
    } finally {
      if (requestVersion === version.current) {
        actionInFlight.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section className="settings-card" aria-label="バックグラウンド通知">
      <h3>バックグラウンド通知</h3>
      <p role="status">{state?.status ?? "確認中…"}</p>
      {state?.pendingAction ? (
        <p>
          端末の通知は停止済みです。
          {state.pendingAction === "delete" ? "登録削除" : "停止"}
          要求はサーバーには未反映です。接続を確認し、
          {state.pendingAction === "delete"
            ? "「サーバー登録を削除」"
            : "「同期を再試行」"}
          で再試行してください。権限撤去の完了はまだ確認できていません。
        </p>
      ) : registration?.state === "stopped" ? (
        <p>ntfyアカウントと読み取り権限の撤去を確認しました。</p>
      ) : registration?.state === "pending" ? (
        <p>
          {state?.enabled
            ? "ntfyアカウントと読み取り権限を設定中です。画面を開いたまま待つか、「同期を再試行」で状態を確認してください。"
            : "停止要求はサーバー受付済みです。ntfyアカウントと権限撤去は処理中です。「同期を再試行」で撤去完了を確認してください。"}
        </p>
      ) : registration?.state === "ready" ? (
        <p>
          ntfyの読み取り権限の設定が完了しました。通知の到達確認はまだ別に必要です。
          初回は下の情報でntfyでログインしてから、「同期を再試行」を押してください。
        </p>
      ) : null}
      {registration?.error && (
        <p role="alert">
          登録処理を完了できません。接続を確認し、「同期を再試行」を押してください。
        </p>
      )}
      {registration &&
        registration.state !== "stopped" &&
        !state?.pendingAction && (
          <fieldset className="ntfy-credentials">
            <legend>ntfyログイン情報</legend>
            <p>
              接続先：<code>{state?.ntfyOrigin ?? "未設定"}</code>
            </p>
            <p>
              ユーザー名：<code>{registration.username}</code>
            </p>
            <label>
              ntfyパスワード
              <input
                type={passwordVisible ? "text" : "password"}
                value={registration.password}
                readOnly
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              aria-pressed={passwordVisible}
              onClick={() => setRevealedFor(passwordVisible ? null : state)}
            >
              {passwordVisible ? "パスワードを隠す" : "パスワードを表示"}
            </button>
            <p className="help">
              この端末専用の情報です。他の人へ共有しないでください。
              ntfyの「設定」→「ユーザー管理」→「ユーザー追加」で接続先・ユーザー名・パスワードを保存します。
            </p>
          </fieldset>
        )}
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
            <strong>この画面で通知を有効にする</strong>
            <p>
              スレネコチェッカーへ戻り、保存内容への同意を選び、「通知を有効にする」を押します。
              中継アプリの選択が表示されたらntfyを選びます。端末専用アカウントと読み取り権限を自動で設定します。
              発行されたログイン情報がこの画面に表示されるまで待ちます。
            </p>
          </li>
          <li>
            <strong>ntfyで端末用アカウントにログインする</strong>
            <p>
              ntfyの「設定」→「一般」→「デフォルトのサーバー」に次のURLを保存します。
              次に「設定」→「ユーザー管理」→「ユーザー追加」を開き、この画面の接続先・ユーザー名・パスワードを入力して保存します。
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
            <strong>この画面で同期を再試行する</strong>
            <p>
              ログイン後にスレネコチェッカーへ戻り、「同期を再試行」を押します。
              「監視中」になったことを確認してください。
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
        </ol>
        <p>
          <strong>確認待ち・同期失敗が続く場合</strong>
        </p>
        <p>
          接続先と、この画面で発行された端末用アカウントのログイン設定を確認してください。
          登録処理中の場合は完了を待ち、ntfyの接続を再試行してください。
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
          {(state.server.error || state.server.delivery?.error) &&
            "サーバー状態を確認できません。接続を確認し、同期を再試行してください。"}
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
        <button
          disabled={busy}
          onClick={() => void act(() => api.stopPush(), "stop")}
        >
          監視を停止
        </button>
        <button
          disabled={busy}
          onClick={() => void act(() => api.deletePush(), "delete")}
        >
          サーバー登録を削除
        </button>
      </div>
    </section>
  );
}
