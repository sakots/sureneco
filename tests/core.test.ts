import { describe, expect, it } from "vitest";
import {
  defaults,
  validateSettings,
  boardUrl,
  threadUrl,
} from "../src/core/settings";
import { parseSubject, parseDat, candidates } from "../src/core/parser";
import { scanPosts, isBlocked } from "../src/core/detection";

const now = Date.parse("2026-10-04T12:00:00+09:00");
const id = String(Math.floor(now / 1000) - 3600);
const line = (
  body: string,
  author = "abc",
  name = "名無しさん (ﾜｯﾁｮｲ abcd-1234)",
  time = "2026/10/04(日) 11:59:00.00",
) => `${name}<>sage<>${time} ID:${author}<>${body}<>タイトル`;

describe("設定", () => {
  it("整数、正規表現、板URLを検証する", () => {
    expect(validateSettings(defaults)).toEqual(defaults);
    for (const change of [
      { update_sec: 29 },
      { update_sec: 30.5 },
      { elapsed_days: 0 },
      { emphasis_sec: NaN },
      { thread_title_regex: "[" },
      { yujinsen_regex: "" },
      { ng_words: "bad" },
      { url: "https://example.com/mj/" },
      { url: "https://egg.5ch.io/test/read.cgi/mj/1/" },
      { url: "https://egg.5ch.io/mj/?x=1" },
    ]) {
      expect(() => validateSettings({ ...defaults, ...change })).toThrow();
    }
    expect(boardUrl("https://egg.5ch.io/mj")).toBe("https://egg.5ch.io/mj/");
    expect(threadUrl(defaults.url, id, 12)).toBe(
      `https://egg.5ch.io/test/read.cgi/mj/${id}/12`,
    );
  });
});

describe("5ch解析", () => {
  it("タイトル内の括弧とHTMLエンティティを保持する", () => {
    const threads = parseSubject(
      `${id}.dat<>【雀魂】じゃんたま (三麻) &amp; 四麻 (123)\nwrong\n`,
    );
    expect(threads).toEqual([
      {
        id,
        title: "【雀魂】じゃんたま (三麻) & 四麻",
        count: 123,
        createdAt: Number(id) * 1000,
      },
    ]);
    expect(candidates(threads, defaults, now)).toHaveLength(1);
    expect(
      candidates(threads, { ...defaults, ng_thread_title_regex: "三麻" }, now),
    ).toHaveLength(0);
    expect(candidates(threads, defaults, now + 15 * 86400000)).toHaveLength(0);
    expect(() => parseSubject("<html>challenge</html>")).toThrow();
  });
  it("DATからID・ワッチョイ・日本時間とテキストを読む", () => {
    const [post] = parseDat(
      line('友人戦<br><a href="evil">&gt;&gt;12</a> &#x1f431;'),
    );
    expect(post).toMatchObject({
      number: 1,
      id: "abc",
      watchoi: "ﾜｯﾁｮｲ abcd-1234",
      body: "友人戦\n>>12 🐱",
      postedAt: now - 60000,
    });
    expect(() => parseDat("<html>blocked</html>")).toThrow();
    expect(() => parseDat(`${line("valid")}\nbroken`)).toThrow();
  });
});

describe("募集の判定", () => {
  it("初期値で四東・四南・三東・三南と5桁の番号を含む募集を検出する", () => {
    for (const mode of ["四東", "四南", "三東", "三南"]) {
      for (const body of [
        `${mode} 12345`,
        `${mode}\n部屋番号：０１２３４`,
        `01234\n${mode} お待ちしています`,
      ]) {
        expect(
          scanPosts(
            id,
            parseDat(line(body.replaceAll("\n", "<br>"))),
            [],
            defaults,
            now,
          ).notifications,
          body,
        ).toHaveLength(1);
      }
      for (const body of [
        mode,
        `${mode} 1234`,
        `${mode} 123456`,
        `${mode} ６12345`,
        `${mode} 12345６`,
      ]) {
        expect(
          scanPosts(
            id,
            parseDat(line(body.replaceAll("\n", "<br>"))),
            [],
            defaults,
            now,
          ).items,
          body,
        ).toHaveLength(0);
      }
    }
    expect(
      scanPosts(id, parseDat(line("12345 東風")), [], defaults, now).items,
    ).toHaveLength(0);
    expect(
      scanPosts(id, parseDat(line("四東 12345 〆")), [], defaults, now)
        .notifications,
    ).toHaveLength(0);
  });
  it("本文は部分一致、IDとワッチョイは完全一致でNGにする", () => {
    const [post] = parseDat(line("友人戦 荒らし"));
    expect(isBlocked(post, { ...defaults, ng_words: ["荒らし"] })).toBe(true);
    expect(isBlocked(post, { ...defaults, ng_ids: ["abc"] })).toBe(true);
    expect(isBlocked(post, { ...defaults, ng_ids: ["ab"] })).toBe(false);
    expect(
      isBlocked(post, { ...defaults, ng_watchois: ["ﾜｯﾁｮｲ abcd-1234"] }),
    ).toBe(true);
  });
  it("古い募集を通知せず、新規募集と締めを区別する", () => {
    const posts = parseDat(
      [
        line("友人戦 12345"),
        line("友人戦 23456", "xyz"),
        line("&gt;&gt;1 〆", "other"),
      ].join("\n"),
    );
    const result = scanPosts(id, posts, [], defaults, now);
    expect(result.items.map((x) => x.closed)).toEqual([true, false]);
    expect(result.notifications.map((x) => x.number)).toEqual([2]);
    expect(
      scanPosts(
        id,
        parseDat(
          line("友人戦 12345", "old", undefined, "2026/10/04(日) 10:00:00.00"),
        ),
        [],
        defaults,
        now,
      ).notifications,
    ).toHaveLength(0);
  });
  it("参照なしの締めは同じ投稿者の募集だけに適用する", () => {
    const posts = parseDat(
      [
        line("友人戦 12345", "abc", "名無し"),
        line("友人戦 23456", "xyz", "名無し"),
        line("〆", "abc", "名無し"),
      ].join("\n"),
    );
    expect(
      scanPosts(id, posts, [], defaults, now).items.map((x) => x.closed),
    ).toEqual([true, false]);
  });
});

describe("ルームIDが必須の募集判定", () => {
  it("募集語句だけ、6桁の番号、5桁のレス参照番号は募集にしない", () => {
    for (const body of [
      "友人戦",
      "友人部屋 あと2人",
      "友人戦 123456",
      "友人戦 >>12345",
    ]) {
      expect(
        scanPosts(id, parseDat(line(body)), [], defaults, now).items,
        body,
      ).toHaveLength(0);
    }
  });
  it("過去レスへの参照と連鎖からIDを取得し、返信も募集にする", () => {
    const posts = parseDat(
      [
        line("四南 ０１２３４"),
        line("&gt;&gt;1 あと2人"),
        line("&gt;&gt;2 お待ちしています"),
      ].join("\n"),
    );
    const result = scanPosts(id, posts.slice(1), [], defaults, now, posts);
    expect(result.items.map((x) => x.roomIds)).toEqual([["01234"], ["01234"]]);
    expect(result.notifications.map((x) => x.number)).toEqual([2, 3]);
  });
  it("複数参照を重複なく解決し、本文にIDがあれば本文を優先する", () => {
    const posts = parseDat(
      [
        line("友人戦 12345"),
        line("友人戦 ５６７８９"),
        line("三東 &gt;&gt;1 &gt;&gt;2 &gt;&gt;1"),
        line("友人戦 01234 &gt;&gt;1"),
      ].join("\n"),
    );
    expect(
      scanPosts(id, posts.slice(2), [], defaults, now, posts).items.map(
        (x) => x.roomIds,
      ),
    ).toEqual([["12345", "56789"], ["01234"]]);
  });
  it("自己・未来・存在しない参照とNG参照先は募集にしない", () => {
    const posts = parseDat(
      [
        line("友人戦 &gt;&gt;1 &gt;&gt;2 &gt;&gt;99"),
        line("友人戦 12345"),
        line("友人戦 &gt;&gt;2"),
      ].join("\n"),
    );
    expect(
      scanPosts(id, [posts[0]], [], defaults, now, posts).items,
    ).toHaveLength(0);
    expect(
      scanPosts(
        id,
        [posts[2]],
        [],
        { ...defaults, ng_words: ["12345"] },
        now,
        posts,
      ).items,
    ).toHaveLength(0);
  });
});
