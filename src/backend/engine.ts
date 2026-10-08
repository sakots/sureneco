import { Monitor } from "../core/monitor";
import { boardUrl, threadUrl, validThreadId } from "../core/settings";
import { loadState } from "../core/state";
import { normalizeRoomId } from "../core/room-id";
import type { Settings } from "../core/types";

declare const nativeFetch: (url: string) => string;
declare const nativeSave: (text: string) => void;
declare const nativeEmit: (text: string) => void;
declare const nativeNotify: (text: string) => void;
declare const nativeURL: (text: string) => string;

// バックエンドで扱う値はJSON形式の設定・スナップショットのみ。
globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
Object.assign(globalThis, {
  URL: class {
    constructor(value: string) {
      Object.assign(this, JSON.parse(nativeURL(value)));
    }
  },
});
let monitor: Monitor;
let state: ReturnType<typeof loadState>;

export function init(
  text: string | null = null,
  notificationAvailable: boolean,
) {
  state = loadState(text);
  monitor = new Monitor(
    state,
    {
      subject: async (url) => nativeFetch(`${boardUrl(url)}subject.txt`),
      dat: async (url, id) => {
        if (!validThreadId(id)) throw new Error("スレッド番号が不正です。");
        return nativeFetch(`${boardUrl(url)}dat/${id}.dat`);
      },
    },
    async (next) => nativeSave(JSON.stringify(next)),
    (item, thread) =>
      nativeNotify(
        JSON.stringify({
          title: `友人戦募集 · ${thread?.title ?? item.threadId}`,
          body: Array.from(item.body).slice(0, 220).join(""),
        }),
      ),
    () => Date.now(),
  );
  monitor.notificationAvailable = notificationAvailable;
  monitor.onChange = (snapshot) => nativeEmit(JSON.stringify(snapshot));
  return JSON.stringify(monitor.snapshot());
}

export async function request(text: string): Promise<string> {
  const { command, payload = {} } = JSON.parse(text);
  let result: unknown = null;
  switch (command) {
    case "notification_status":
      monitor.notificationAvailable = !!payload.available;
      result = monitor.snapshot();
      break;
    case "snapshot":
      result = monitor.snapshot();
      break;
    case "refresh":
      await monitor.refresh();
      break;
    case "watch":
      await monitor.watch(payload.id, payload.enabled);
      await monitor.refresh();
      break;
    case "settings":
      await monitor.saveSettings(payload.settings as Settings);
      await monitor.refresh();
      break;
    case "open_thread":
      result = threadUrl(state.settings.url, payload.id, payload.post);
      break;
    case "copy_room_id":
      result = normalizeRoomId(payload.id);
      break;
    case "launch":
      result = { id: normalizeRoomId(payload.id), settings: state.settings };
      break;
    default:
      throw new Error("未対応の操作です。");
  }
  return JSON.stringify(result);
}

export function interval(): number {
  return state.settings.update_sec;
}
