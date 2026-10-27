import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../core/types";
import { DismissibleMessage } from "./DismissibleMessage";

type Session = { active: boolean; busy: boolean };

export function AutostartPanel({ api }: { api: DesktopApi }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const sessionRef = useRef<Session | null>(null);

  useEffect(() => {
    const session = { active: true, busy: true };
    sessionRef.current = session;
    void readStatus(session);
    return () => {
      session.active = false;
    };
  }, [api]);

  async function readStatus(session: Session, changeError = "") {
    if (!session.active) return;
    session.busy = true;
    setPending(true);
    setEnabled(null);
    setError(changeError);
    try {
      const actual = await api.getAutostart();
      if (session.active) setEnabled(actual);
    } catch (err) {
      if (session.active) {
        const detail = err instanceof Error ? err.message : String(err);
        setError(
          changeError && changeError !== detail
            ? `${changeError} / ${detail}`
            : detail,
        );
      }
    } finally {
      if (session.active) {
        session.busy = false;
        setPending(false);
      }
    }
  }

  async function toggle() {
    const session = sessionRef.current;
    if (!session?.active || session.busy || enabled === null) return;
    session.busy = true;
    setPending(true);
    setError("");
    try {
      const actual = await api.setAutostart(!enabled);
      if (session.active) setEnabled(actual);
    } catch (err) {
      if (session.active)
        await readStatus(
          session,
          err instanceof Error ? err.message : String(err),
        );
    } finally {
      if (session.active) {
        session.busy = false;
        setPending(false);
      }
    }
  }

  function refresh() {
    const session = sessionRef.current;
    if (session?.active && !session.busy) void readStatus(session);
  }

  return (
    <section className="settings-card">
      <h3>ログイン時の起動</h3>
      <p className="help">
        現在のユーザーのログイン時に起動します。未登録の場合、既定はオフです。
        自動起動でも通常のウィンドウを表示し、保存済みの条件で監視します。
      </p>
      <label className="autostart-toggle">
        <input
          type="checkbox"
          checked={enabled === true}
          aria-checked={enabled === null ? "mixed" : enabled}
          aria-describedby="autostart-status"
          ref={(input) => {
            if (input) input.indeterminate = enabled === null;
          }}
          disabled={pending || enabled === null}
          onChange={() => void toggle()}
        />
        ログイン時に自動起動する
      </label>
      <p id="autostart-status" role="status">
        {pending
          ? enabled === null
            ? "自動起動の状態を確認中…"
            : "自動起動を変更中…"
          : enabled === null
            ? "自動起動の状態は未確認です。"
            : enabled
              ? "自動起動はオンです。"
              : "自動起動はオフです。"}
      </p>
      {error && (
        <DismissibleMessage
          message={error}
          tone="error"
          onDismiss={() => setError("")}
        />
      )}
      <button className="secondary" disabled={pending} onClick={refresh}>
        状態を再確認
      </button>
      <p className="help">
        ポータブル版・AppImageなどは実行ファイルを移動・削除する前にオフにし、移動後に再設定してください。設定フォルダの変更では自動起動の登録は変わりません。
      </p>
    </section>
  );
}
