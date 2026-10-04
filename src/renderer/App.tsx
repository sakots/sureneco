import { useEffect, useState } from "react";
import { defaults, validateSettings } from "../core/settings";
import { isRecent } from "../core/detection";
import { extractRoomIds, splitRoomIds } from "../core/room-id";
import type { Api, Settings, Snapshot } from "../core/types";
const labels: Record<keyof Settings, string> = {
  update_sec: "更新間隔（秒）",
  elapsed_days: "候補の経過日数（日）",
  emphasis_sec: "新規募集の有効期間（秒）",
  thread_title_regex: "スレッド名の正規表現",
  ng_thread_title_regex: "除外するスレッド名の正規表現",
  yujinsen_regex: "募集レスの正規表現",
  closed_yujinsen_regex: "締めレスの正規表現",
  url: "5chの板URL",
  ng_words: "NG本文",
  ng_ids: "NG ID",
  ng_watchois: "NGワッチョイ",
};
const numeric = ["update_sec", "elapsed_days", "emphasis_sec"] as const;
const patterns = [
  "thread_title_regex",
  "ng_thread_title_regex",
  "yujinsen_regex",
  "closed_yujinsen_regex",
] as const;
const ng = ["ng_words", "ng_ids", "ng_watchois"] as const;
export function App({ api }: { api: Api }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<"threads" | "recruitments" | "settings">(
    "threads",
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const stop = api.subscribe((value) => {
      if (alive) setSnapshot(value);
    });
    void api
      .getSnapshot()
      .then((value) => {
        if (alive) setSnapshot(value);
      })
      .catch((err) => {
        if (alive) setError(String(err));
      });
    const timer = setInterval(() => setTick((x) => x + 1), 10000);
    return () => {
      alive = false;
      stop();
      clearInterval(timer);
    };
  }, [api]);
  async function act(task: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  const roomIdButton = (roomId: string, text: string, key: number | string) => (
    <button
      key={key}
      className="room-id"
      aria-label={`ルームID ${roomId}をコピー`}
      title="ルームIDをコピー"
      disabled={busy}
      onClick={() =>
        void act(async () => {
          await api.copyRoomId(roomId);
          setNotice(`ルームID ${roomId}をコピーしました。`);
        })
      }
    >
      {text}
    </button>
  );
  const watched = snapshot?.watched ?? [];
  const recent =
    snapshot?.recruitments.filter(
      (x) => !x.closed && isRecent(x, snapshot.settings, Date.now()),
    ).length ?? 0;
  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            猫
          </span>
          <div>
            <h1>sureneco</h1>
            <p>雀魂の友人戦を、見逃さずに。</p>
          </div>
        </div>
        <span className="status">
          <span className={`dot ${watched.length ? "active" : ""}`} />
          {watched.length
            ? `${watched.length}スレッドを監視中`
            : "監視するスレッドを選択"}
        </span>
      </header>
      <nav aria-label="画面">
        <button
          aria-current={page === "threads" ? "page" : undefined}
          onClick={() => setPage("threads")}
        >
          スレッド <span>{snapshot?.threads.length ?? 0}</span>
        </button>
        <button
          aria-current={page === "recruitments" ? "page" : undefined}
          onClick={() => setPage("recruitments")}
        >
          友人戦募集 <span>{recent}</span>
        </button>
        <button
          aria-current={page === "settings" ? "page" : undefined}
          onClick={() => setPage("settings")}
        >
          設定
        </button>
      </nav>
      {error && (
        <div role="alert" className="message error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="message success">
          {notice}
        </div>
      )}
      {snapshot?.errors.map((e, i) => (
        <div className="message error" role="alert" key={i}>
          {e}
        </div>
      ))}
      {snapshot && !snapshot.notificationAvailable && (
        <div className="message">
          この環境ではデスクトップ通知を利用できません。
        </div>
      )}
      {!snapshot ? (
        <p className="empty">読み込み中…</p>
      ) : (
        <main>
          {page === "threads" && (
            <>
              <div className="section-head">
                <div>
                  <h2>雀魂スレッド</h2>
                  <p>通知を受け取りたいスレッドを選んでください。</p>
                </div>
                <button
                  className="secondary"
                  disabled={busy || snapshot.refreshing}
                  onClick={() => void act(() => api.refresh())}
                >
                  {snapshot.refreshing ? "更新中…" : "今すぐ更新"}
                </button>
              </div>
              <div className="thread-list">
                {snapshot.threads.map((t) => (
                  <article className="thread" key={t.id}>
                    <div className="thread-content">
                      <button
                        className="thread-title"
                        onClick={() => void act(() => api.openThread(t.id))}
                      >
                        {t.title}
                        <span aria-hidden="true"> ↗</span>
                      </button>
                      <p>
                        {t.count.toLocaleString()} レス <span>·</span>{" "}
                        {new Date(t.createdAt).toLocaleDateString("ja-JP")} 作成
                      </p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={watched.includes(t.id)}
                      aria-label={`${t.title}を監視`}
                      className="switch"
                      disabled={busy}
                      onClick={() =>
                        void act(() => api.watch(t.id, !watched.includes(t.id)))
                      }
                    >
                      <span />
                    </button>
                  </article>
                ))}
              </div>
              {!snapshot.threads.length && (
                <div className="empty">
                  <strong>候補のスレッドがありません</strong>
                  <p>
                    更新するか、設定の正規表現と経過日数を確認してください。
                  </p>
                </div>
              )}
              {watched
                .filter((id) => !snapshot.threads.some((t) => t.id === id))
                .map((id) => (
                  <article className="thread" key={id}>
                    <div>
                      <strong>スレッド {id}</strong>
                      <p>一覧にありません。監視を続けています。</p>
                    </div>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void act(() => api.watch(id, false))}
                    >
                      監視を解除
                    </button>
                  </article>
                ))}
              <aside className="hint">
                初回取得の既存レスは通知しません。次の更新から新しい募集をお知らせします。
              </aside>
            </>
          )}
          {page === "recruitments" && (
            <>
              <div className="section-head">
                <div>
                  <h2>友人戦募集</h2>
                  <p>監視開始後に見つかった募集を表示します。</p>
                </div>
                <span className="badge">募集中 {recent}</span>
              </div>
              {snapshot.recruitments.map((item) => {
                const active =
                  !item.closed && isRecent(item, snapshot.settings, Date.now());
                const directIds = extractRoomIds(item.body);
                const referencedIds = item.roomIds.filter(
                  (id) => !directIds.includes(id),
                );
                return (
                  <article
                    className={`recruitment ${active ? "fresh" : ""}`}
                    key={`${item.threadId}-${item.number}`}
                  >
                    <div className="recruitment-head">
                      <div className="recruitment-summary">
                        <strong>レス {item.number}</strong>
                        <span className={`badge ${active ? "green" : ""}`}>
                          {item.closed
                            ? "締め切り"
                            : active
                              ? "募集中"
                              : "期限切れ"}
                        </span>
                      </div>
                      <time>
                        {new Date(item.postedAt).toLocaleString("ja-JP")}
                      </time>
                    </div>
                    <div className="recruitment-body">
                      {splitRoomIds(item.body).map((part, index) =>
                        part.roomId
                          ? roomIdButton(part.roomId, part.text, index)
                          : part.text,
                      )}
                    </div>
                    {referencedIds.length > 0 && (
                      <div className="referenced-rooms">
                        <span>参照先のルームID</span>{" "}
                        {referencedIds.map((id) => roomIdButton(id, id, id))}
                      </div>
                    )}
                    <button
                      className="secondary"
                      onClick={() =>
                        void act(() =>
                          api.openThread(item.threadId, item.number),
                        )
                      }
                    >
                      レスを開く
                    </button>
                    <p className="metadata">
                      {item.id ? `ID:${item.id}` : item.name} {item.watchoi}
                    </p>
                    <p className="metadata">
                      {snapshot.threads.find((t) => t.id === item.threadId)
                        ?.title ?? item.threadId}
                    </p>
                  </article>
                );
              })}
              {!snapshot.recruitments.length && (
                <div className="empty">
                  <strong>まだ募集はありません</strong>
                  <p>スレッドを監視すると、ここに新しい募集が届きます。</p>
                </div>
              )}
            </>
          )}
          {page === "settings" && (
            <SettingsForm
              initial={snapshot.settings}
              busy={busy}
              onSave={(settings) =>
                act(async () => {
                  await api.saveSettings(settings);
                  setNotice("設定を保存しました。");
                })
              }
            />
          )}
        </main>
      )}
      <footer>
        <span>
          {snapshot?.updatedAt
            ? `最終更新 ${new Date(snapshot.updatedAt).toLocaleTimeString("ja-JP")}`
            : "未更新"}{" "}
          {snapshot ? `· ${snapshot.settings.update_sec}秒ごとに更新` : ""}
        </span>
        <span>閉じるとトレイに常駐します</span>
      </footer>
    </div>
  );
}
function SettingsForm({
  initial,
  busy,
  onSave,
}: {
  initial: Settings;
  busy: boolean;
  onSave: (s: Settings) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<keyof Settings, string>>(
    () =>
      Object.fromEntries(
        Object.entries(initial).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join("\n") : String(value),
        ]),
      ) as Record<keyof Settings, string>,
  );
  const [error, setError] = useState("");
  const field = (key: keyof Settings) => (
    <label key={key} htmlFor={key}>
      {labels[key]}
      {ng.includes(key as (typeof ng)[number]) ? (
        <textarea
          id={key}
          rows={3}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        />
      ) : (
        <input
          id={key}
          type={
            numeric.includes(key as (typeof numeric)[number])
              ? "number"
              : "text"
          }
          min={key === "update_sec" ? 30 : 1}
          step={1}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        />
      )}
    </label>
  );
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        try {
          const candidate = {
            ...draft,
            ...Object.fromEntries(numeric.map((k) => [k, Number(draft[k])])),
            ...Object.fromEntries(ng.map((k) => [k, draft[k].split("\n")])),
          };
          void onSave(validateSettings(candidate));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }}
    >
      <div className="section-head">
        <div>
          <h2>設定</h2>
          <p>検出条件と通知の対象を調整できます。</p>
        </div>
      </div>
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      <section className="settings-card">
        <h3>取得と通知</h3>
        <div className="numeric-grid">{numeric.map(field)}</div>
        {field("url")}
        <p className="help">
          板URLを変えると、監視対象と取得済みレス番号をリセットします。
        </p>
      </section>
      <section className="settings-card">
        <h3>検出する正規表現</h3>
        <p className="help">
          大文字小文字は区別しません。除外するスレッド名は空欄にできます。
        </p>
        {patterns.map(field)}
      </section>
      <section className="settings-card">
        <h3>NG設定</h3>
        <p className="help">
          一行に一件。本文は部分一致、ID・ワッチョイは完全一致で除外します。
        </p>
        {ng.map(field)}
      </section>
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            setDraft(
              Object.fromEntries(
                Object.entries(defaults).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? value.join("\n") : String(value),
                ]),
              ) as Record<keyof Settings, string>,
            );
            setError("");
          }}
        >
          既定値を入力
        </button>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "保存中…" : "設定を保存"}
        </button>
      </div>
    </form>
  );
}
