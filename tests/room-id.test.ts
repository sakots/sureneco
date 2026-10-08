import { expect, it } from "vitest";
import { splitRoomIds, normalizeRoomId } from "../src/core/room-id";

it("独立した5桁を抽出し、長い数値からは抽出しない", () => {
  const parts = splitRoomIds(
    "友人戦01234\n５６７８９ / 123456 / １２３４５６ / 1234",
  );
  expect(parts.filter((x) => x.roomId).map((x) => x.roomId)).toEqual([
    "01234",
    "56789",
  ]);
  expect(parts.map((x) => x.text).join("")).toBe(
    "友人戦01234\n５６７８９ / 123456 / １２３４５６ / 1234",
  );
});
it("先頭ゼロと全角を扱い、不正なコピー要求を拒否する", () => {
  expect(normalizeRoomId("０１２３４")).toBe("01234");
  for (const input of [
    12345,
    null,
    "1234",
    "123456",
    "a12345",
    "12345\n",
    " 12345",
  ]) {
    expect(() => normalizeRoomId(input)).toThrow();
  }
});

it("レス参照番号はルームIDにしない", () => {
  const parts = splitRoomIds("友人戦 >>12345 ＞＞ ５６７８９ 01234");
  expect(parts.filter((x) => x.roomId).map((x) => x.roomId)).toEqual(["01234"]);
  expect(parts.map((x) => x.text).join("")).toBe(
    "友人戦 >>12345 ＞＞ ５６７８９ 01234",
  );
});
