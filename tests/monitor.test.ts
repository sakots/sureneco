import { expect, it, vi } from "vitest";
import { Monitor } from "../src/core/monitor";
import { defaults } from "../src/core/settings";
import type { SavedState } from "../src/core/types";

it("起動時に既存募集を確認し、通常更新では重複せず、取得失敗から回復する", async () => {
  const now = Date.parse("2026-10-04T12:00:00+09:00");
  const id = String(now / 1000 - 3600);
  const state: SavedState = { settings: defaults, watched: [id], cursors: {} };
  let count = 1;
  let fail = false;
  const post = "名無し<>sage<>2026/10/04(日) 11:59:30 ID:abc<>友人戦 12345<>";
  const notify = vi.fn();
  const save = vi.fn(async () => {});
  const client = {
    subject: vi.fn(async () => `${id}.dat<>雀魂 (3)`),
    dat: vi.fn(async () => {
      if (fail) throw new Error("HTTP 403");
      return Array(count).fill(post).join("\n");
    }),
  };
  const monitor = new Monitor(state, client, save, notify, () => now);
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(state.cursors[id]).toBe(1);
  count = 2;
  await monitor.refresh();
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(2);
  fail = true;
  count = 3;
  await monitor.refresh();
  expect(monitor.snapshot().errors.join("")).toContain("403");
  expect(state.cursors[id]).toBe(2);
  fail = false;
  notify.mockClear();
  const restarted = new Monitor(state, client, save, notify, () => now);
  await restarted.refresh();
  expect(notify.mock.calls.map((call) => call[0].number)).toEqual([1, 2, 3]);
  await restarted.refresh();
  expect(notify).toHaveBeenCalledTimes(3);
  expect(restarted.snapshot().errors).toEqual([]);
  expect(save).toHaveBeenCalled();
});

it("重複更新をまとめ、監視解除・再開時に基準をリセットする", async () => {
  const state: SavedState = {
    settings: defaults,
    watched: ["1791034502"],
    cursors: { "1791034502": 12 },
  };
  const client = { subject: vi.fn(async () => ""), dat: vi.fn(async () => "") };
  const monitor = new Monitor(
    state,
    client,
    async () => {},
    () => {},
  );
  await Promise.all([monitor.refresh(), monitor.refresh()]);
  expect(client.subject).toHaveBeenCalledTimes(1);
  await monitor.watch("1791034502", false);
  expect(state.cursors).toEqual({});
  await monitor.watch("1791034502", true);
  expect(state.watched).toEqual(["1791034502"]);
});

it("保存が失敗した取得は通知せず、再試行で新規レスを通知する", async () => {
  const now = Date.parse("2026-10-04T12:00:00+09:00");
  const state: SavedState = {
    settings: defaults,
    watched: ["1791034502"],
    cursors: { "1791034502": 0 },
  };
  const client = {
    subject: async () => "",
    dat: async () =>
      "名無し<>sage<>2026/10/04(日) 11:59:30 ID:abc<>友人戦 12345<>",
  };
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  const notify = vi.fn();
  const monitor = new Monitor(state, client, save, notify, () => now);
  await monitor.refresh();
  expect(state.cursors["1791034502"]).toBe(0);
  expect(notify).not.toHaveBeenCalled();
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(1);
});

it("板URLの変更で監視対象をリセットし、保存失敗時は設定を維持する", async () => {
  const state: SavedState = {
    settings: structuredClone(defaults),
    watched: ["1791034502"],
    cursors: { "1791034502": 1 },
  };
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  const monitor = new Monitor(
    state,
    { subject: async () => "", dat: async () => "" },
    save,
    () => {},
  );
  await expect(
    monitor.saveSettings({ ...defaults, url: "https://egg.5ch.net/mj/" }),
  ).rejects.toThrow("disk full");
  expect(state.settings.url).toBe(defaults.url);
  expect(state.watched).toHaveLength(1);
  await monitor.saveSettings({ ...defaults, url: "https://egg.5ch.net/mj/" });
  expect(state.watched).toEqual([]);
  expect(state.cursors).toEqual({});
});

it("初回取得したレスを参照して新規募集を検出し、再起動後も解決する", async () => {
  const now = Date.parse("2026-10-04T12:00:00+09:00");
  const state: SavedState = {
    settings: defaults,
    watched: ["1791034502"],
    cursors: {},
  };
  const original =
    "名無し<>sage<>2026/10/04(日) 11:59:00 ID:abc<>友人戦 01234<>";
  const reply =
    "名無し<>sage<>2026/10/04(日) 11:59:30 ID:abc<>&gt;&gt;1 あと1人<>";
  let dat = original;
  const client = { subject: async () => "", dat: async () => dat };
  const notify = vi.fn();
  const save = async () => {};
  await new Monitor(state, client, save, notify, () => now).refresh();
  expect(notify).toHaveBeenCalledTimes(1);
  notify.mockClear();
  dat += `\n${reply}`;
  const monitor = new Monitor(state, client, save, notify, () => now);
  await monitor.refresh();
  await monitor.refresh();
  expect(notify.mock.calls.map((call) => call[0].number)).toEqual([1, 2]);
  expect(monitor.snapshot().recruitments[0]).toMatchObject({
    number: 2,
    roomIds: ["01234"],
  });
});

it("再起動後も、初回取得で締まった募集と期限切れの募集への返信を通知しない", async () => {
  const now = Date.parse("2026-10-04T12:00:00+09:00");
  for (const ended of ["closed", "expired"]) {
    const state: SavedState = {
      settings: defaults,
      watched: ["1791034502"],
      cursors: {},
    };
    const time = ended === "expired" ? "10:00:00" : "11:59:00";
    let dat = `名無し<>sage<>2026/10/04(日) ${time} ID:abc<>友人戦 01234<>`;
    if (ended === "closed")
      dat += "\n名無し<>sage<>2026/10/04(日) 11:59:10 ID:abc<>&gt;&gt;1 〆<>";
    const client = { subject: async () => "", dat: async () => dat };
    const notify = vi.fn();
    const save = async () => {};
    await new Monitor(state, client, save, notify, () => now).refresh();
    dat +=
      "\n名無し<>sage<>2026/10/04(日) 11:59:30 ID:reply<>&gt;&gt;1 あと1人<>";
    const restarted = new Monitor(state, client, save, notify, () => now);
    await restarted.refresh();
    expect(notify).not.toHaveBeenCalled();
    expect(
      restarted.snapshot().recruitments.filter((item) => !item.closed),
    ).toHaveLength(0);
    expect(restarted.snapshot().errors).toEqual([]);
  }
});

it("ワッチョイの許可設定を通知に反映し、解除後も既存レスを再通知しない", async () => {
  const now = Date.parse("2026-10-04T12:00:00+09:00");
  const id = "1791034502";
  const state: SavedState = {
    settings: { ...defaults, allowed_watchois: ["ﾜｯﾁｮｲ allowed"] },
    watched: [id],
    cursors: { [id]: 0 },
  };
  const post = (watchoi: string, room: string) =>
    `名無し (${watchoi})<>sage<>2026/10/04(日) 11:59:30 ID:${room}<>友人戦 ${room}<>`;
  let dat = [post("ﾜｯﾁｮｲ allowed", "12345"), post("ﾜｯﾁｮｲ other", "23456")].join(
    "\n",
  );
  const notify = vi.fn();
  const monitor = new Monitor(
    state,
    { subject: async () => "", dat: async () => dat },
    async () => {},
    notify,
    () => now,
  );
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0].watchoi).toBe("ﾜｯﾁｮｲ allowed");
  expect(monitor.snapshot().recruitments).toHaveLength(2);
  await monitor.saveSettings({ ...state.settings, allowed_watchois: [] });
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(1);
  dat += `\n${post("ﾜｯﾁｮｲ other", "34567")}`;
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(2);
});

it.each(["toggle", "startup"])(
  "%s時に既存の有効な募集と返信だけを通知する",
  async (mode) => {
    const now = Date.parse("2026-10-04T12:00:00+09:00");
    const id = "1791034502";
    const state: SavedState = {
      settings: {
        ...defaults,
        allowed_watchois: ["ﾜｯﾁｮｲ allowed"],
        ng_words: ["NG"],
      },
      watched: mode === "startup" ? [id] : [],
      cursors: mode === "startup" ? { [id]: 9 } : {},
    };
    const post = (
      body: string,
      author = "abc",
      time = "11:59:30",
      watchoi = "ﾜｯﾁｮｲ allowed",
    ) =>
      `名無し (${watchoi})<>sage<>2026/10/04(日) ${time} ID:${author}<>${body}<>`;
    const dat = [
      post("友人戦 12345", "old", "10:00:00"),
      post("友人戦 23456", "closed"),
      post("&gt;&gt;2 〆", "other"),
      post("友人戦 34567 NG", "ng"),
      post("友人戦 45678", "excluded", undefined, "ﾜｯﾁｮｲ other"),
      post("友人戦 56789", "live"),
      post("&gt;&gt;6 あと1人", "reply"),
      post("友人戦", "no-room"),
      post("&gt;&gt;1 あと1人", "expired-reply"),
    ].join("\n");
    const notify = vi.fn();
    const monitor = new Monitor(
      state,
      { subject: async () => "", dat: async () => dat },
      async () => {},
      notify,
      () => now,
    );
    if (mode === "toggle") await monitor.watch(id, true);
    await monitor.refresh();
    expect(notify.mock.calls.map((call) => call[0].number)).toEqual([6, 7]);
    expect(state.cursors[id]).toBe(9);
    await monitor.refresh();
    expect(notify).toHaveBeenCalledTimes(2);
  },
);
it("再開時に既存募集を再確認し、重複したオン操作と通常更新では再通知しない", async () => {
  const now = Date.parse("2026-10-04T12:00:00+09:00");
  const id = "1791034502";
  const state: SavedState = { settings: defaults, watched: [], cursors: {} };
  const notify = vi.fn();
  const monitor = new Monitor(
    state,
    {
      subject: async () => "",
      dat: async () =>
        "名無し<>sage<>2026/10/04(日) 11:59:30 ID:abc<>友人戦 12345<>",
    },
    async () => {},
    notify,
    () => now,
  );
  await monitor.watch(id, true);
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(1);
  await monitor.watch(id, true);
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(1);
  await monitor.watch(id, false);
  await monitor.watch(id, true);
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(2);
  expect(monitor.snapshot().recruitments).toHaveLength(1);
  const restarted = new Monitor(
    state,
    {
      subject: async () => "",
      dat: async () =>
        "名無し<>sage<>2026/10/04(日) 11:59:30 ID:abc<>友人戦 12345<>",
    },
    async () => {},
    notify,
    () => now,
  );
  await restarted.refresh();
  expect(notify).toHaveBeenCalledTimes(3);
  await restarted.refresh();
  expect(notify).toHaveBeenCalledTimes(3);
});

it("保存済みのレス番号があっても、起動時の取得失敗後に既存募集を再確認する", async () => {
  const now = Date.parse("2026-10-04T12:00:00+09:00");
  const id = "1791034502";
  const state: SavedState = {
    settings: defaults,
    watched: [id],
    cursors: { [id]: 2 },
  };
  const dat = [
    "名無し<>sage<>2026/10/04(日) 10:00:00 ID:old<>友人戦 12345<>",
    "名無し<>sage<>2026/10/04(日) 11:59:30 ID:live<>友人戦 23456<>",
  ].join("\n");
  const client = {
    subject: async () => "",
    dat: vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 403"))
      .mockResolvedValue(dat),
  };
  const notify = vi.fn();
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  const monitor = new Monitor(state, client, save, notify, () => now);
  await monitor.refresh();
  expect(monitor.snapshot().errors.join("")).toContain("403");
  await monitor.refresh();
  expect(monitor.snapshot().errors.join("")).toContain("disk full");
  expect(notify).not.toHaveBeenCalled();
  expect(state.cursors[id]).toBe(2);
  await monitor.refresh();
  expect(notify.mock.calls.map((call) => call[0].number)).toEqual([2]);
  expect(monitor.snapshot().recruitments.map((item) => item.number)).toEqual([
    2,
  ]);
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(1);
});

function pollingFixture(count = 1) {
  const clock = { now: Date.parse("2026-10-04T12:00:00+09:00") };
  const id = String(clock.now / 1000 - 3600);
  const nextId = String(clock.now / 1000 - 60);
  const state: SavedState = {
    settings: { ...defaults, update_sec: 20, thread_update_sec: 300 },
    watched: [id],
    cursors: {},
  };
  const data = {
    count,
    subject: `${id}.dat<>雀魂 (1)`,
  };
  const client = {
    subject: vi.fn(async () => data.subject),
    dat: vi.fn(async () =>
      Array(data.count)
        .fill("名無し<>sage<>2026/10/04(日) 10:00:00 ID:abc<>雑談<>")
        .join("\n"),
    ),
  };
  const monitor = new Monitor(
    state,
    client,
    async () => {},
    () => {},
    () => clock.now,
  );
  return { monitor, client, state, clock, data, id, nextId };
}

it("募集は毎回取得し、一覧だけ独立した間隔で取得してdatのレス数を表示する", async () => {
  const { monitor, client, clock, data, id } = pollingFixture();
  await monitor.refresh();
  expect(client.subject).toHaveBeenCalledTimes(1);
  data.count = 2;
  clock.now += 20_000;
  await monitor.refresh();
  expect(
    monitor.snapshot().threads.find((thread) => thread.id === id)?.count,
  ).toBe(2);
  clock.now += 279_999;
  await monitor.refresh();
  expect(client.subject).toHaveBeenCalledTimes(1);
  clock.now += 1;
  await monitor.refresh();
  expect(client.subject).toHaveBeenCalledTimes(2);
  expect(client.dat).toHaveBeenCalledTimes(4);
  expect(monitor.snapshot().threads[0].count).toBe(2);
});

it("900レスを超えても一覧は設定間隔まで取得せず、datのレス数だけ更新する", async () => {
  const { monitor, client, clock, data, id, nextId } = pollingFixture(900);
  await monitor.refresh(false, true);
  data.count = 901;
  data.subject += `\n${nextId}.dat<>雀魂 次スレ (1)`;
  clock.now += 20_000;
  await monitor.refresh(false, true);
  expect(client.subject).toHaveBeenCalledTimes(1);
  expect(monitor.snapshot().threads.map((thread) => thread.id)).not.toContain(
    nextId,
  );
  expect(
    monitor.snapshot().threads.find((thread) => thread.id === id)?.count,
  ).toBe(901);
  clock.now += 280_000;
  await monitor.refresh(false, true);
  expect(client.subject).toHaveBeenCalledTimes(2);
  expect(monitor.snapshot().threads.map((thread) => thread.id)).toContain(
    nextId,
  );
});

it("一覧取得の失敗は間隔を待たず次の募集更新で再試行する", async () => {
  const { monitor, client } = pollingFixture();
  client.subject.mockRejectedValueOnce(new Error("HTTP 403"));
  await monitor.refresh();
  expect(monitor.snapshot().errors.join("")).toContain("403");
  await monitor.refresh();
  expect(client.subject).toHaveBeenCalledTimes(2);
  expect(monitor.snapshot().errors).toEqual([]);
  await monitor.refresh();
  expect(client.subject).toHaveBeenCalledTimes(2);
  expect(client.dat).toHaveBeenCalledTimes(3);
});

it("強制更新は間隔内でも一覧を取得し、通常更新との同時呼び出しを併合する", async () => {
  const { monitor, client } = pollingFixture();
  await monitor.refresh();
  await Promise.all([
    monitor.refresh(),
    monitor.refresh(true),
    monitor.refresh(true),
  ]);
  expect(client.subject).toHaveBeenCalledTimes(2);
  expect(client.dat).toHaveBeenCalledTimes(2);
  await monitor.refresh();
  expect(client.subject).toHaveBeenCalledTimes(2);
  await monitor.refresh(true);
  expect(client.subject).toHaveBeenCalledTimes(3);
});

it("dat取得中の強制更新も進行中の更新へ併合して一覧を取得する", async () => {
  const { monitor, client } = pollingFixture();
  await monitor.refresh();
  let release!: (text: string) => void;
  let started!: () => void;
  const datStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  client.dat.mockImplementationOnce(() => {
    started();
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  });
  const automatic = monitor.refresh();
  await datStarted;
  const manual = monitor.refresh(true);
  release("名無し<>sage<>2026/10/04(日) 10:00:00 ID:abc<>雑談<>");
  await Promise.all([automatic, manual]);
  expect(client.subject).toHaveBeenCalledTimes(2);
  expect(client.dat).toHaveBeenCalledTimes(2);
});

it("板変更時に一覧の取得間隔をリセットする", async () => {
  const { monitor, client, data, state, id } = pollingFixture();
  await monitor.refresh();
  await monitor.saveSettings({
    ...state.settings,
    url: "https://egg.5ch.net/mj/",
  });
  data.subject = `${id}.dat<>雀魂 別の板 (1)`;
  await monitor.watch(id, true);
  await monitor.refresh();
  expect(client.subject).toHaveBeenCalledTimes(2);
  expect(client.subject).toHaveBeenLastCalledWith("https://egg.5ch.net/mj/");
  await monitor.refresh();
  expect(client.subject).toHaveBeenCalledTimes(2);
});

it.each([
  { recruitmentSec: 20, threadSec: 300, datCalls: 16, subjectCalls: 2 },
  { recruitmentSec: 300, threadSec: 20, datCalls: 2, subjectCalls: 16 },
])(
  "自動更新では募集$recruitmentSec秒・一覧$threadSec秒を独立して判定する",
  async ({ recruitmentSec, threadSec, datCalls, subjectCalls }) => {
    const { monitor, client, state, clock } = pollingFixture();
    state.settings.update_sec = recruitmentSec;
    state.settings.thread_update_sec = threadSec;
    await monitor.refresh(false, true);
    for (let i = 0; i < 15; i++) {
      clock.now += 20_000;
      await monitor.refresh(false, true);
    }
    expect(client.dat).toHaveBeenCalledTimes(datCalls);
    expect(client.subject).toHaveBeenCalledTimes(subjectCalls);
    await monitor.refresh(true);
    expect(client.dat).toHaveBeenCalledTimes(datCalls + 1);
    expect(client.subject).toHaveBeenCalledTimes(subjectCalls + 1);
  },
);

it("自動更新で募集の間隔を待っていても監視変更後の通常呼び出しはdatを取得する", async () => {
  const { monitor, client, state, nextId } = pollingFixture();
  state.settings.update_sec = 300;
  state.settings.thread_update_sec = 20;
  await monitor.refresh(false, true);
  await monitor.refresh(false, true);
  expect(client.dat).toHaveBeenCalledTimes(1);
  await monitor.watch(nextId, true);
  await monitor.refresh();
  expect(client.dat).toHaveBeenCalledTimes(3);
  expect(client.subject).toHaveBeenCalledTimes(1);
});

it("定期的な一覧取得中に手動更新が来ても一覧と募集の取得を重複しない", async () => {
  const { monitor, client, data, clock } = pollingFixture();
  await monitor.refresh();
  clock.now += 300_000;
  let release!: (text: string) => void;
  let started!: () => void;
  const subjectStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  client.subject.mockImplementationOnce(() => {
    started();
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  });
  const automatic = monitor.refresh();
  await subjectStarted;
  const manual = monitor.refresh(true);
  release(data.subject);
  await Promise.all([automatic, manual]);
  expect(client.subject).toHaveBeenCalledTimes(2);
  expect(client.dat).toHaveBeenCalledTimes(2);
});
