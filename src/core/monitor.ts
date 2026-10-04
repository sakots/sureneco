import { candidates, parseDat, parseSubject } from "./parser";
import { isBlocked, scanPosts } from "./detection";
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
export class Monitor {
  private threads: Thread[] = [];
  private items: Recruitment[] = [];
  private errors: string[] = [];
  private updatedAt: number | null = null;
  private refreshing = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Promise<void> | null = null;
  onChange: (snapshot: Snapshot) => void = () => {};
  notificationAvailable = true;
  constructor(
    private state: SavedState,
    private client: Client,
    private save: (state: SavedState) => Promise<void>,
    private notify: (item: Recruitment, thread?: Thread) => void,
    private now: () => number = Date.now,
  ) {}
  snapshot(): Snapshot {
    return structuredClone({
      settings: this.state.settings,
      watched: this.state.watched,
      threads: this.threads,
      recruitments: this.items
        .filter((x) => !isBlocked(x, this.state.settings))
        .slice()
        .reverse(),
      errors: this.errors,
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
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.serialize(() => this.poll()).finally(() => {
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
      try {
        const all = parseSubject(await this.client.subject(settings.url));
        this.threads = all.filter(
          (t) =>
            this.state.watched.includes(t.id) ||
            candidates([t], settings, this.now()).length,
        );
      } catch (error) {
        this.errors.push(`スレッド一覧: ${errorMessage(error)}`);
      }
      for (const id of this.state.watched) {
        try {
          const posts = parseDat(await this.client.dat(settings.url, id));
          const cursor = this.state.cursors[id];
          const nextCursors = {
            ...this.state.cursors,
            [id]: Math.max(cursor ?? 0, posts.length),
          };
          const detected = scanPosts(
            id,
            cursor === undefined ? [] : posts.filter((p) => p.number > cursor),
            this.items,
            settings,
            this.now(),
          );
          await this.save({ ...this.state, cursors: nextCursors });
          this.state.cursors = nextCursors;
          this.items = detected.items;
          for (const item of detected.notifications) {
            try {
              this.notify(
                item,
                this.threads.find((t) => t.id === id),
              );
            } catch (error) {
              this.errors.push(`通知: ${errorMessage(error)}`);
            }
          }
        } catch (error) {
          this.errors.push(
            `${this.threads.find((t) => t.id === id)?.title ?? id}: ${errorMessage(error)}`,
          );
        }
      }
      this.updatedAt = this.now();
    } finally {
      this.refreshing = false;
      this.emit();
    }
  }
  watch(id: string, enabled: boolean): Promise<void> {
    if (!validThreadId(id) || typeof enabled !== "boolean")
      return Promise.reject(new Error("監視対象が不正です。"));
    return this.serialize(async () => {
      const watched = this.state.watched.filter((x) => x !== id);
      if (enabled) watched.push(id);
      const cursors = { ...this.state.cursors };
      if (this.state.watched.includes(id) !== enabled) delete cursors[id];
      const next = { ...this.state, watched, cursors };
      await this.save(next);
      Object.assign(this.state, next);
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
        this.threads = [];
        this.items = [];
      }
      this.emit();
    });
  }
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
