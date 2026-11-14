import { describe, expect, it, vi } from "vitest";
import { parseDeadline, recruitmentExpiresAt } from "../src/core/deadline";
import { isRecent, scanPosts } from "../src/core/detection";
import { defaults } from "../src/core/settings";
import { Monitor } from "../src/core/monitor";
import type { Post } from "../src/core/types";

const posted = Date.parse("2026-11-14T21:00:00+09:00");
const thread = "1794648000";
const post = (body: string, at = posted, number = 1): Post => ({
  number,
  body,
  postedAt: at,
  name: "名無し",
  id: "host",
  watchoi: "",
});

describe("募集本文の指定締切", () => {
  it.each([
    ["21時10分まで", 10],
    ["２１時１０分まで", 10],
    ["21:10まで", 10],
    ["２１：１０まで", 10],
    ["10分で締め切り", 10],
    ["10分で締切", 10],
    ["5分後爆破", 5],
    ["５分後に爆破します", 5],
    ["5分後に締め切ります", 5],
  ])("予告を即時締めとせず指定時刻で失効する: %s", (phrase, minutes) => {
    const candidate = post(`友人戦 12345 ${phrase}`);
    const at = posted + minutes * 60_000;
    const result = scanPosts(thread, [candidate], [], defaults, at - 1);
    expect(result.notifications.map((item) => item.roomIds)).toEqual([
      ["12345"],
    ]);
    expect(result.items[0].closed).toBe(false);
    expect(result.items[0].deadlineAt).toBe(at);
    expect(isRecent(result.items[0], defaults, at)).toBe(false);
    expect(
      scanPosts(thread, [candidate], [], defaults, at).notifications,
    ).toEqual([]);
  });

  it("既定期間より後の明示時刻も優先し、複数候補なら早い方を使う", () => {
    const long = post("友人戦 12345 23時まで");
    expect(
      scanPosts(
        thread,
        [long],
        [],
        defaults,
        posted + 110 * 60_000,
      ).notifications.map((x) => x.number),
    ).toEqual([1]);
    const multiple = post("友人戦 12345 21時30分まで / 5分後爆破");
    expect(recruitmentExpiresAt(multiple, defaults)).toBe(posted + 5 * 60_000);
  });

  it("分だけの時刻とあと何分の相対指定を区別する", () => {
    const at = posted + 7 * 60_000;
    expect(
      recruitmentExpiresAt(post("友人戦 12345 10分で締切", at), defaults),
    ).toBe(posted + 10 * 60_000);
    expect(
      recruitmentExpiresAt(post("友人戦 12345 あと10分で締切", at), defaults),
    ).toBe(posted + 17 * 60_000);
    expect(
      recruitmentExpiresAt(post("友人戦 12345 残り10分で爆破", at), defaults),
    ).toBe(posted + 17 * 60_000);
  });

  it("日またぎと分だけの翌時間帯を投稿日時から計算する", () => {
    const late = Date.parse("2026-11-14T23:55:20+09:00");
    expect(
      recruitmentExpiresAt(post("友人戦 12345 0時10分まで", late), defaults),
    ).toBe(Date.parse("2026-11-15T00:10:00+09:00"));
    expect(
      recruitmentExpiresAt(post("友人戦 12345 5分で締め切り", late), defaults),
    ).toBe(Date.parse("2026-11-15T00:05:00+09:00"));
    const sameMinute = post("友人戦 12345 55分まで", late);
    expect(isRecent(sameMinute, defaults, late)).toBe(false);
  });

  it("直近の過去時刻と遅延取得を翌日や取得基準で延長しない", () => {
    const late = post("友人戦 12345 21時10分まで", posted + 20 * 60_000);
    expect(
      scanPosts(thread, [late], [], defaults, late.postedAt).notifications,
    ).toEqual([]);
    const relative = post("友人戦 12345 5分後爆破");
    expect(
      scanPosts(thread, [relative], [], defaults, posted + 6 * 60_000)
        .notifications,
    ).toEqual([]);
  });

  it.each([
    "25時10分まで",
    "21時90分まで",
    "99分で締切",
    "-5分後爆破",
    "1.5分後爆破",
    "集合は21時10分",
    "あと5分",
    "10分で締め切りました",
  ])("不正値や締切でない時間を採用しない: %s", (text) => {
    expect(parseDeadline(post(text))).toBeNull();
  });

  it("予告以外の即時締めを優先する", () => {
    for (const text of [
      "友人戦 12345 10分で締め切り 〆",
      "友人戦 12345 10分で締め切りました",
    ]) {
      expect(
        scanPosts(thread, [post(text)], [], defaults, posted).notifications,
      ).toEqual([]);
    }
  });

  it("参照した部屋の締切を返信で延長せず、再評価でも失わない", () => {
    const source = post("友人戦 12345 5分後爆破");
    const reply = post(">>1 あと1人 30分後爆破", posted + 60_000, 2);
    const initial = scanPosts(
      thread,
      [source, reply],
      [],
      defaults,
      reply.postedAt,
    );
    expect(initial.notifications.map((item) => item.deadlineAt)).toEqual([
      posted + 5 * 60_000,
      posted + 5 * 60_000,
    ]);
    const expiry = posted + 5 * 60_000;
    expect(
      scanPosts(thread, [reply], [], defaults, expiry, [source, reply])
        .notifications,
    ).toEqual([]);
    const refreshed = scanPosts(thread, [], initial.items, defaults, expiry, [
      source,
      reply,
    ]);
    expect(
      refreshed.items.every((item) => !isRecent(item, defaults, expiry)),
    ).toBe(true);
  });

  it("指定がない場合は設定期間の従来の境界を維持する", () => {
    const candidate = post("友人戦 12345");
    expect(
      isRecent(candidate, defaults, posted + defaults.emphasis_sec * 1000),
    ).toBe(true);
    expect(
      isRecent(candidate, defaults, posted + defaults.emphasis_sec * 1000 + 1),
    ).toBe(false);
  });

  it("起動時にも指定締切を優先し、既定期間を過ぎた有効募集を確認する", async () => {
    const notify = vi.fn();
    const monitor = new Monitor(
      { settings: defaults, watched: [thread], cursors: { [thread]: 1 } },
      {
        subject: async () => `${thread}.dat<>雀魂 (1)`,
        dat: async () =>
          "名無し<>sage<>2026/11/14(土) 21:00:00 ID:host<>友人戦 12345 23時まで<>",
      },
      async () => {},
      notify,
      () => posted + 110 * 60_000,
    );
    await monitor.refresh();
    expect(
      notify.mock.calls.map((call) => call[0].recruitment.roomIds),
    ).toEqual([["12345"]]);
  });
});
