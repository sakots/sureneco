import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow, Rectangle } from "electron";
export interface WindowState extends Rectangle {
  maximized: boolean;
}
export class WindowStateStore {
  private path: string;
  constructor(private directory: string) {
    this.path = join(directory, "window-state.json");
  }
  load(): WindowState | null {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        !["x", "y", "width", "height"].every((key) =>
          Number.isSafeInteger(value[key]),
        ) ||
        value.width <= 0 ||
        value.height <= 0 ||
        typeof value.maximized !== "boolean"
      )
        return null;
      const { x, y, width, height, maximized } = value;
      return { x, y, width, height, maximized };
    } catch {
      return null;
    }
  }
  save(state: WindowState): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(state, null, 2), "utf8");
    renameSync(`${this.path}.tmp`, this.path);
  }
}
export function restoreWindowState(
  saved: WindowState | null,
  workAreas: Rectangle[],
): WindowState & { minWidth: number; minHeight: number } {
  let area = workAreas[0];
  let overlap = 0;
  if (saved) {
    for (const candidate of workAreas) {
      const width = Math.max(
        0,
        Math.min(saved.x + saved.width, candidate.x + candidate.width) -
          Math.max(saved.x, candidate.x),
      );
      const height = Math.max(
        0,
        Math.min(saved.y + saved.height, candidate.y + candidate.height) -
          Math.max(saved.y, candidate.y),
      );
      if (width * height > overlap) {
        overlap = width * height;
        area = candidate;
      }
    }
  }
  const minWidth = Math.min(400, area.width);
  const minHeight = Math.min(600, area.height);
  const width = Math.min(area.width, Math.max(minWidth, saved?.width ?? 1120));
  const height = Math.min(
    area.height,
    Math.max(minHeight, saved?.height ?? 820),
  );
  const x = saved?.x ?? area.x + Math.floor((area.width - width) / 2);
  const y = saved?.y ?? area.y + Math.floor((area.height - height) / 2);
  return {
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
    width,
    height,
    minWidth,
    minHeight,
    maximized: saved?.maximized ?? false,
  };
}
export function captureWindowState(
  window: Pick<
    BrowserWindow,
    "getNormalBounds" | "isMaximized" | "isMinimized"
  >,
  wasMaximized: boolean,
): WindowState {
  return {
    ...window.getNormalBounds(),
    maximized: window.isMinimized() ? wasMaximized : window.isMaximized(),
  };
}
