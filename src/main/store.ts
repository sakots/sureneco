import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { defaults, validateSettings, validThreadId } from "../core/settings";
import type { SavedState } from "../core/types";
export class Store {
  private path: string;
  constructor(private directory: string) {
    this.path = join(directory, "state.json");
  }
  async load(): Promise<SavedState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          settings: structuredClone(defaults),
          watched: [],
          cursors: {},
        };
      throw error;
    }
    try {
      const data = JSON.parse(text) as SavedState;
      const settings = validateSettings(data.settings);
      if (
        !Array.isArray(data.watched) ||
        !data.watched.every(validThreadId) ||
        !data.cursors ||
        Array.isArray(data.cursors) ||
        typeof data.cursors !== "object"
      )
        throw new Error("保存形式が不正です。");
      for (const [id, n] of Object.entries(data.cursors))
        if (!validThreadId(id) || !Number.isSafeInteger(n) || n < 0)
          throw new Error("レス番号が不正です。");
      return {
        settings,
        watched: [...new Set(data.watched)],
        cursors: data.cursors,
      };
    } catch {
      throw new Error(
        `保存ファイルを読み込めません。内容を確認してください: ${this.path}`,
      );
    }
  }
  async save(state: SavedState) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(`${this.path}.tmp`, JSON.stringify(state, null, 2), "utf8");
    await rename(`${this.path}.tmp`, this.path);
  }
}
