import { afterEach, expect, it, vi } from "vitest";
import { fetchText } from "../src/main/client";
afterEach(() => vi.unstubAllGlobals());
it("HTTPエラーを伝え、UTF-8レスポンスを読む", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response("blocked", { status: 403 }))
    .mockResolvedValueOnce(
      new Response("雀魂", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(fetchText("https://egg.5ch.io/mj/subject.txt")).rejects.toThrow(
    "403",
  );
  expect(await fetchText("https://egg.5ch.io/mj/subject.txt")).toBe("雀魂");
  expect(fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      redirect: "error",
      signal: expect.any(AbortSignal),
    }),
  );
});
it("Shift_JISを読み、5MiB超を拒否する", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(new Uint8Array([0x90, 0x9d, 0x8d, 0xb0])),
    )
    .mockResolvedValueOnce(new Response(new Uint8Array(5 * 1024 * 1024 + 1)));
  vi.stubGlobal("fetch", fetch);
  expect(await fetchText("https://egg.5ch.io/mj/subject.txt")).toBe("雀魂");
  await expect(fetchText("https://egg.5ch.io/mj/subject.txt")).rejects.toThrow(
    "5MiB",
  );
});
