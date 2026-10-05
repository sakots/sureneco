import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/main/store";
it("設定を保存・再読込し、破損したファイルを上書きしない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sureneco-"));
  try {
    const store = new Store(dir);
    const state = await store.load();
    state.settings.allowed_watchois = ["ﾜｯﾁｮｲ allowed"];
    state.watched = ["1791034502"];
    state.cursors = { "1791034502": 100 };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    const { allowed_watchois, ...existingSettings } = state.settings;
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ ...state, settings: existingSettings }),
    );
    expect(await store.load()).toEqual({
      ...state,
      settings: { ...existingSettings, allowed_watchois: [] },
    });
    await writeFile(join(dir, "state.json"), "broken");
    await expect(store.load()).rejects.toThrow();
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe("broken");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
