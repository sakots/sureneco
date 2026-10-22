export type Theme = "system" | "light" | "dark";
const storageKey = "sureneco.theme";
export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage may be unavailable; the system preference still works.
  }
  return "system";
}
export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // Keep the selected theme for this session even if persistence fails.
  }
}
export function applyTheme(
  theme: Theme,
  systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ??
    false,
) {
  document.documentElement.dataset.theme =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;
}
