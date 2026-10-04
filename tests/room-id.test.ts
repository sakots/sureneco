import { expect, it, vi } from "vitest";
import { splitRoomIds, normalizeRoomId } from "../src/core/room-id";
vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
import { clipboard } from "electron";
import { copyRoomId } from "../src/main/clipboard";

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
  copyRoomId("０１２３４");
  expect(clipboard.writeText).toHaveBeenCalledWith("01234");
  vi.mocked(clipboard.writeText).mockClear();
  expect(() => copyRoomId("invalid")).toThrow();
  expect(clipboard.writeText).not.toHaveBeenCalled();
});
