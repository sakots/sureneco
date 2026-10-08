import { defaults, validateSettings, validThreadId } from "./settings";
import type { SavedState } from "./types";

export function loadState(text: string | null): SavedState {
  if (text === null)
    return { settings: structuredClone(defaults), watched: [], cursors: {} };
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
}
