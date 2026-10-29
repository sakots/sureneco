import { useEffect, useState } from "react";
import { defaults, validateSettings } from "../core/settings";
import { isRecent } from "../core/detection";
import { extractRoomIds, postReferences, splitRoomIds } from "../core/room-id";
import type { Api, Settings, Snapshot, UpdateState } from "../core/types";
import { MobilePushPanel } from "./MobilePushPanel";
import { AutostartPanel } from "./AutostartPanel";
import { UpdatePanel } from "./UpdatePanel";
import { ThemeToggle } from "./ThemeToggle";
import {
  DismissibleMessage,
  DismissibleMessageList,
} from "./DismissibleMessage";
const labels: Record<keyof Settings, string> = {
  update_sec: "友人戦募集の更新間隔（秒）",
  thread_update_sec: "スレッド一覧の更新間隔（秒）",
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
  allowed_watchois: "通知を許可するワッチョイ",
  launcher_mode: "起動方法",
  launcher_path: "実行ファイルのフルパス",
  launcher_args: "起動引数（一行に一つ）",
  launcher_profile: "プロファイルディレクトリー名",
  launcher_user_data_dir: "ユーザーデータディレクトリー（任意）",
};
const numeric = [
  "update_sec",
  "thread_update_sec",
  "elapsed_days",
  "emphasis_sec",
] as const;
const patterns = [
  "thread_title_regex",
  "ng_thread_title_regex",
  "yujinsen_regex",
  "closed_yujinsen_regex",
] as const;
const ng = ["ng_words", "ng_ids", "ng_watchois"] as const;
const lists = [...ng, "allowed_watchois", "launcher_args"] as const;
export function App({ api }: { api: Api }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<"threads" | "recruitments" | "settings">(
    "threads",
  );
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [configDirectory, setConfigDirectory] = useState<string | null>(null);
  const [configDirectoryDraft, setConfigDirectoryDraft] = useState("");
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
    const stopUpdates = api.mobile
      ? () => {}
      : api.subscribeUpdate((value) => {
          if (alive) setUpdate(value);
        });
    if (!api.mobile) {
      void api
        .getUpdateState()
        .then((value) => {
          if (alive) setUpdate(value);
        })
        .catch((err) => {
          if (alive) setError(String(err));
        });
      void api
        .getConfigDirectory()
        .then((value) => {
          if (alive) {
            setConfigDirectory(value);
            setConfigDirectoryDraft(value);
          }
        })
        .catch((err) => {
          if (alive) setError(String(err));
        });
    }
    const timer = setInterval(() => setTick((x) => x + 1), 10000);
    return () => {
      alive = false;
      stop();
      stopUpdates();
      clearInterval(timer);
    };
  }, [api]);
  useEffect(() => {
    if (!api.mobile) return;
    const refresh = () => {
      if (!document.hidden) void api.refresh().catch(() => {});
    };
    const tapped = () => setPage("recruitments");
    const consume = () => {
      if (!document.hidden)
        void api.mobile
          ?.consumeNotificationTarget?.()
          .then((target) => {
            if (target) tapped();
          })
          .catch(() => {});
    };
    const targets = setInterval(consume, 1000);
    consume();
    const timer = setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("show-recruitments", tapped);
    refresh();
    return () => {
      clearInterval(targets);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("show-recruitments", tapped);
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
  const roomIdButton = (
    roomId: string,
    text: string,
    key: number | string,
    post: number,
  ) => (
    <button
      key={key}
      className="room-id"
      aria-label={`ルームID ${roomId}をコピー`}
      title="ルームIDをコピー"
      disabled={busy}
      onClick={() =>
        void act(async () => {
          await api.copyRoomId(roomId);
          setNotice(`レス ${post}：ルームID ${roomId}をコピーしました。`);
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
            <h1>スレネコチェッカー</h1>
            <p>友人戦するにゃ！</p>
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
      {update && ["available", "downloaded"].includes(update.status) && (
        <div hidden={page === "settings"}>
          <DismissibleMessage
            message={`スレネコチェッカー v${update.latestVersion}に更新できます。`}
            action={
              <button className="secondary" onClick={() => setPage("settings")}>
                更新画面を開く
              </button>
            }
          />
        </div>
      )}
      {error && (
        <DismissibleMessage
          message={error}
          tone="error"
          onDismiss={() => setError("")}
        />
      )}
      {notice && (
        <DismissibleMessage
          message={notice}
          tone="success"
          onDismiss={() => setNotice("")}
        />
      )}
      <DismissibleMessageList messages={snapshot?.notices ?? []} />
      <DismissibleMessageList messages={snapshot?.errors ?? []} tone="error" />
      {snapshot && !api.mobile && !snapshot.notificationAvailable && (
        <DismissibleMessage message="この環境ではデスクトップ通知を利用できません。" />
      )}
      {!snapshot ? (
        <p className="empty">読み込み中…</p>
      ) : (
        <main>
          {/* Keep system-theme tracking active while other pages are shown. */}
          <section
            className="settings-card"
            hidden={page !== "settings"}
            aria-labelledby="theme-heading"
          >
            <h3 id="theme-heading">表示テーマ</h3>
            <ThemeToggle />
            <p className="help">
              システム → ライト →
              ダークの順に切り替えます。システムではOSの明暗設定に合わせます。
            </p>
          </section>
          {page === "threads" && (
            <>
              <div className="section-head">
                <div>
                  <h2>雀魂スレッド</h2>
                  <p>通知を受け取りたいスレッドを選んでください。</p>
                </div>
                <button
                  className="secondary thread-refresh"
                  disabled={busy || snapshot.refreshing}
                  aria-busy={snapshot.refreshing}
                  onClick={() => void act(() => api.refresh())}
                >
                  <span aria-hidden={snapshot.refreshing}>今すぐ更新</span>
                  <span aria-hidden={!snapshot.refreshing}>更新中…</span>
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
                起動時と監視をオンにしたときに、現在募集中の友人戦を確認して通知します。その後は新しい募集をお知らせします。
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
                const noticePost = postReferences(item.body)[0] ?? item.number;
                return (
                  <article
                    className={`recruitment ${active ? "fresh" : ""}`}
                    key={`${item.threadId}-${item.number}`}
                  >
                    <div className="recruitment-head">
                      <div className="recruitment-summary">
                        <strong>レス {item.number}</strong>
                        <span
                          className={`badge ${item.closed ? "closed" : active ? "green" : "expired"}`}
                        >
                          {item.closed
                            ? "満員（〆）"
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
                          ? roomIdButton(
                              part.roomId,
                              part.text,
                              index,
                              noticePost,
                            )
                          : part.text,
                      )}
                    </div>
                    {referencedIds.length > 0 && (
                      <div className="referenced-rooms">
                        <span>参照先のルームID</span>{" "}
                        {referencedIds.map((id) =>
                          roomIdButton(id, id, id, noticePost),
                        )}
                      </div>
                    )}
                    <div className="recruitment-actions">
                      {!api.mobile &&
                        item.roomIds.map((id) => (
                          <button
                            key={id}
                            className="secondary"
                            disabled={busy || !active}
                            aria-label={`ルームID ${id}をコピーして雀魂を起動`}
                            onClick={() =>
                              void act(async () => {
                                await api.launchMahjongSoul(id);
                                setNotice(
                                  `レス ${noticePost}：ルームID ${id}をコピーして雀魂を起動しました。ゲーム内の友人戦で貼り付けてください。`,
                                );
                              })
                            }
                          >
                            雀魂を起動
                            {item.roomIds.length > 1 ? `（${id}）` : ""}
                          </button>
                        ))}
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
                    </div>
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
            <>
              {api.mobile && <MobilePushPanel api={api.mobile} />}
              {!api.mobile && update && (
                <UpdatePanel api={api} state={update} />
              )}
              {!api.mobile && api.desktop && (
                <AutostartPanel api={api.desktop} />
              )}
              {!api.mobile && (
                <section className="settings-card">
                  <h3>設定フォルダ</h3>
                  <p className="metadata">
                    現在の保存先：{" "}
                    <span>{configDirectory ?? "読み込み中…"}</span>
                  </p>
                  <label htmlFor="config-directory">
                    設定フォルダのパス
                    <input
                      id="config-directory"
                      type="text"
                      value={configDirectoryDraft}
                      disabled={busy || configDirectory === null}
                      aria-describedby="config-directory-help"
                      onChange={(event) =>
                        setConfigDirectoryDraft(event.target.value)
                      }
                    />
                  </label>
                  <p className="help" id="config-directory-help">
                    絶対パスを入力するか、フォルダを選択してください。「保存先を変更」で保存済みの設定、監視対象、取得済みレス番号を変更先にコピーし、以後の保存先にします。元のフォルダのデータは残ります。state.json
                    が既にあるフォルダには変更できません。ウィンドウの位置・サイズは移しません。
                  </p>
                  <div className="form-actions">
                    <button
                      className="secondary"
                      disabled={busy || configDirectory === null}
                      onClick={() =>
                        void act(async () => {
                          const selected = await api.chooseConfigDirectory();
                          if (selected !== null)
                            setConfigDirectoryDraft(selected);
                        })
                      }
                    >
                      フォルダを選択
                    </button>
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        configDirectory === null ||
                        !configDirectoryDraft.trim()
                      }
                      onClick={() =>
                        void act(async () => {
                          const directory =
                            await api.changeConfigDirectory(
                              configDirectoryDraft,
                            );
                          setConfigDirectory(directory);
                          setConfigDirectoryDraft(directory);
                          setNotice("設定フォルダを変更しました。");
                        })
                      }
                    >
                      保存先を変更
                    </button>
                  </div>
                </section>
              )}
              <SettingsForm
                mobile={!!api.mobile}
                initial={snapshot.settings}
                busy={busy}
                onSave={(settings) =>
                  act(async () => {
                    await api.saveSettings(settings);
                    setNotice("設定を保存しました。");
                  })
                }
              />
            </>
          )}
        </main>
      )}
      <footer>
        <span>
          {snapshot?.updatedAt
            ? `最終更新 ${new Date(snapshot.updatedAt).toLocaleTimeString("ja-JP")}`
            : "未更新"}{" "}
          {snapshot
            ? `· 友人戦募集：${snapshot.settings.update_sec}秒ごと · スレッド一覧：${snapshot.settings.thread_update_sec}秒ごと`
            : ""}
        </span>
        <span>
          {api.mobile
            ? "更新はGoogle Playから行います"
            : "閉じるとトレイに常駐します"}
        </span>
      </footer>
    </div>
  );
}
function SettingsForm({
  initial,
  mobile = false,
  busy,
  onSave,
}: {
  initial: Settings;
  mobile?: boolean;
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
      {lists.includes(key as (typeof lists)[number]) ? (
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
          min={
            key === "update_sec" || key === "thread_update_sec"
              ? mobile
                ? 60
                : 20
              : 1
          }
          max={
            numeric.includes(key as (typeof numeric)[number])
              ? 2147483
              : undefined
          }
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
            ...Object.fromEntries(lists.map((k) => [k, draft[k].split("\n")])),
          };
          if (
            mobile &&
            (Number(candidate.update_sec) < 60 ||
              Number(candidate.thread_update_sec) < 60)
          )
            throw new Error("Androidの更新間隔は60秒以上にしてください。");
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
        <DismissibleMessage
          message={error}
          tone="error"
          onDismiss={() => setError("")}
        />
      )}
      <section className="settings-card">
        <h3>取得と通知</h3>
        <div className="numeric-grid">{numeric.map(field)}</div>
        <p className="help">
          スレッド一覧は起動時と設定した間隔で更新します。
          今すぐ更新と設定保存時は、友人戦募集とスレッド一覧の両方を更新します。
        </p>
        {field("url")}
        <p className="help">
          板URLを変えると、監視対象と取得済みレス番号をリセットします。
        </p>
      </section>
      {!mobile && (
        <section className="settings-card">
          <h3>雀魂の起動</h3>
          <p className="help">
            募集のボタンからルームIDをコピーして起動します。入室はゲーム内でIDを貼り付けてください。
          </p>
          <label htmlFor="launcher_mode">
            起動方法
            <select
              id="launcher_mode"
              value={draft.launcher_mode}
              onChange={(e) =>
                setDraft({ ...draft, launcher_mode: e.target.value })
              }
            >
              <option value="default">既定ブラウザー</option>
              <option value="browser">Chrome / Edge（プロファイル指定）</option>
              <option value="application">指定アプリ（雀魂・Steamなど）</option>
            </select>
          </label>
          {draft.launcher_mode !== "default" && field("launcher_path")}
          {draft.launcher_mode === "browser" && (
            <>
              {field("launcher_profile")}
              {field("launcher_user_data_dir")}
              <p className="help">
                chrome://version または edge://version
                のプロファイルパス末尾（Default、Profile
                1など）を指定します。空欄ならブラウザーの既定設定を使います。ユーザーデータディレクトリーは通常空欄で構いません。
              </p>
            </>
          )}
          {draft.launcher_mode === "application" && (
            <>
              {field("launcher_args")}
              <p className="help">
                空白を含む引数も引用符で囲まず、一行に一つ入力します。Steam経由の場合はsteam.exeを指定し、-applaunchと対象ゲームのApp
                IDを二行に分けて入力します。
              </p>
            </>
          )}
        </section>
      )}
      <section className="settings-card">
        <h3>検出する正規表現</h3>
        <p className="help">
          大文字小文字は区別しません。除外するスレッド名は空欄にできます。
        </p>
        {patterns.map(field)}
      </section>
      <section className="settings-card">
        <h3>通知する投稿者</h3>
        <p className="help">
          一行に一件。ワッチョイ全体を入力してください。完全一致する投稿者の募集だけを通知します。
          空欄なら全投稿者が対象です。NG設定が優先され、募集一覧には通知対象外の募集も表示されます。
        </p>
        {field("allowed_watchois")}
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
