import { candidates, parseDat, parseSubject } from "./parser";
import { isBlocked, isRecent, scanPosts } from "./detection";
import { validateSettings, validThreadId } from "./settings";
import type {
  Recruitment,
  SavedState,
  Settings,
  Snapshot,
  Thread,
} from "./types";
export interface Client {
  subject(url: string): Promise<string>;
  dat(url: string, id: string): Promise<string>;
}
export type MonitorNotification =
  | { type: "recruitment"; recruitment: Recruitment; thread?: Thread }
  | { type: "new_thread"; thread: Thread };
export class Monitor {
  private threads: Thread[] = [];
  private seenCandidates: Set<string> | null = null;
  private items: Recruitment[] = [];
  private errors: string[] = [];
  private notices = new Map<string, { message: string; expiresAt: number }>();
  private updatedAt: number | null = null;
  private refreshing = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Promise<void> | null = null;
  private forceThreads = false;
  private forceRecruitments = false;
  private lastThreadsAt: number | null = null;
  private lastRecruitmentsAt: number | null = null;
  private retryThreads = false;
  private startupChecks: Set<string>;
  onChange: (snapshot: Snapshot) => void = () => {};
  notificationAvailable = true;
  constructor(
    private state: SavedState,
    private client: Client,
    private save: (state: SavedState) => Promise<void>,
    private notify: (event: MonitorNotification) => void,
    private now: () => number = Date.now,
  ) {
    this.startupChecks = new Set(state.watched);
  }
  snapshot(): Snapshot {
    const now = this.now();
    for (const [id, notice] of this.notices) {
      if (notice.expiresAt <= now) this.notices.delete(id);
    }
    return structuredClone({
      settings: this.state.settings,
      watched: this.state.watched,
      threads: this.threads,
      recruitments: this.items
        .filter((x) => !isBlocked(x, this.state.settings))
        .reverse(),
      errors: this.errors,
      notices: Array.from(this.notices.values(), (notice) => notice.message),
      updatedAt: this.updatedAt,
      refreshing: this.refreshing,
      notificationAvailable: this.notificationAvailable,
    });
  }
  private emit() {
    this.onChange(this.snapshot());
  }
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => {});
    return next;
  }
  refresh(forceThreads = false, scheduled = false): Promise<void> {
    this.forceThreads ||= forceThreads;
    this.forceRecruitments ||= !scheduled;
    if (this.pending) return this.pending;
    this.pending = this.serialize(async () => {
      do {
        await this.poll();
      } while (this.forceThreads || this.forceRecruitments);
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async poll() {
    this.refreshing = true;
    this.errors = [];
    this.emit();
    try {
      const settings = this.state.settings;
      const datCounts = new Map<string, number>();
      const listDue =
        this.forceThreads ||
        this.retryThreads ||
        this.lastThreadsAt === null ||
        this.now() - this.lastThreadsAt >= settings.thread_update_sec * 1000;
      // 起動時だけ先に一覧を取得し、初回通知にもスレッド名を使う。
      const initialList = this.lastThreadsAt === null;
      if (initialList) await this.refreshThreads(settings, datCounts);
      const recruitmentsDue =
        this.forceRecruitments ||
        this.lastRecruitmentsAt === null ||
        this.now() - this.lastRecruitmentsAt >= settings.update_sec * 1000;
      if (recruitmentsDue) {
        this.lastRecruitmentsAt = this.now();
        for (const id of this.state.watched) {
          try {
            const posts = parseDat(await this.client.dat(settings.url, id));
            datCounts.set(id, posts.length);
            const thread = this.threads.find((t) => t.id === id);
            if (thread) thread.count = posts.length;
            if (posts.length > 1000) {
              await this.stopCompletedThread(id, thread?.title);
              continue;
            }
            const cursor = this.state.cursors[id];
            const now = this.now();
            const rescan = this.startupChecks.has(id) || cursor === 0;
            const nextCursors = {
              ...this.state.cursors,
              [id]: Math.max(cursor ?? 0, posts.length),
            };
            const detected = scanPosts(
              id,
              rescan
                ? posts.filter((p) => isRecent(p, settings, now))
                : posts.filter((p) => p.number > (cursor ?? 0)),
              rescan
                ? this.items.filter((item) => item.threadId !== id)
                : this.items,
              settings,
              now,
              posts,
            );
            await this.save({ ...this.state, cursors: nextCursors });
            this.state.cursors = nextCursors;
            this.items = detected.items;
            this.startupChecks.delete(id);
            for (const item of detected.notifications) {
              this.sendNotification({
                type: "recruitment",
                recruitment: item,
                thread: this.threads.find((t) => t.id === id),
              });
            }
          } catch (error) {
            this.errors.push(
              `${this.threads.find((t) => t.id === id)?.title ?? id}: ${errorMessage(error)}`,
            );
          }
        }
      }
      if (this.forceThreads || (!initialList && listDue))
        await this.refreshThreads(settings, datCounts);
      if (recruitmentsDue) this.forceRecruitments = false;
      this.updatedAt = this.now();
    } finally {
      this.refreshing = false;
      this.emit();
    }
  }
  private sendNotification(event: MonitorNotification) {
    try {
      this.notify(event);
    } catch (error) {
      this.errors.push(`通知: ${errorMessage(error)}`);
    }
  }
  private async refreshThreads(
    settings: Settings,
    datCounts: Map<string, number>,
  ): Promise<void> {
    try {
      const all = parseSubject(await this.client.subject(settings.url));
      const eligible = candidates(all, settings, this.now());
      const candidateIds = new Set(eligible.map((thread) => thread.id));
      this.threads = all.filter(
        (t) => this.state.watched.includes(t.id) || candidateIds.has(t.id),
      );
      for (const thread of this.threads) {
        if (thread.count > 1000 && this.state.watched.includes(thread.id))
          await this.stopCompletedThread(thread.id, thread.title);
        const count = datCounts.get(thread.id);
        if (count !== undefined) thread.count = count;
      }
      this.lastThreadsAt = this.now();
      this.retryThreads = false;
      const initialized = this.seenCandidates !== null;
      this.seenCandidates ??= new Set();
      for (const thread of eligible) {
        if (this.seenCandidates.has(thread.id)) continue;
        this.seenCandidates.add(thread.id);
        if (initialized) this.sendNotification({ type: "new_thread", thread });
      }
    } catch (error) {
      this.retryThreads = true;
      this.errors.push(`スレッド一覧: ${errorMessage(error)}`);
    } finally {
      this.forceThreads = false;
    }
  }
  private async setWatching(id: string, enabled: boolean): Promise<void> {
    const watched = this.state.watched.filter((x) => x !== id);
    if (enabled) watched.push(id);
    const cursors = { ...this.state.cursors };
    if (this.state.watched.includes(id) !== enabled) {
      if (enabled) cursors[id] = 0;
      else delete cursors[id];
    }
    const next = { ...this.state, watched, cursors };
    await this.save(next);
    Object.assign(this.state, next);
    if (!enabled) this.startupChecks.delete(id);
  }
  private async stopCompletedThread(id: string, title = id): Promise<void> {
    await this.setWatching(id, false);
    this.notices.set(id, {
      message: `${title}: レス数が1000を超えたため、監視を自動停止しました。`,
      expiresAt: this.now() + 30_000,
    });
  }
  watch(id: string, enabled: boolean): Promise<void> {
    if (!validThreadId(id) || typeof enabled !== "boolean")
      return Promise.reject(new Error("監視対象が不正です。"));
    return this.serialize(async () => {
      await this.setWatching(id, enabled);
      if (enabled) this.notices.delete(id);
      this.emit();
    });
  }
  saveSettings(input: Settings): Promise<void> {
    const settings = validateSettings(input);
    return this.serialize(async () => {
      const changedBoard = settings.url !== this.state.settings.url;
      const next = {
        ...this.state,
        settings,
        watched: changedBoard ? [] : this.state.watched,
        cursors: changedBoard ? {} : this.state.cursors,
      };
      await this.save(next);
      Object.assign(this.state, next);
      if (changedBoard) {
        this.startupChecks.clear();
        this.threads = [];
        this.seenCandidates = null;
        this.items = [];
        this.notices.clear();
        this.lastThreadsAt = null;
        this.lastRecruitmentsAt = null;
        this.retryThreads = false;
      }
      this.emit();
    });
  }
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
