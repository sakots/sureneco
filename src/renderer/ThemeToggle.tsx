import { useEffect, useState } from "react";
import { applyTheme, readTheme, saveTheme, type Theme } from "./theme";
const labels = { system: "システム", light: "ライト", dark: "ダーク" };
const nextTheme: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};
export function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const update = () => applyTheme(theme, media?.matches ?? false);
    update();
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, [theme]);
  const next = nextTheme[theme];
  return (
    <button
      type="button"
      className="secondary theme-toggle"
      aria-label={`テーマ：${labels[theme]}。${labels[next]}に切り替え`}
      title={`${labels[next]}に切り替え（システム → ライト → ダーク）`}
      onClick={() => {
        saveTheme(next);
        setTheme(next);
      }}
    >
      <span aria-hidden="true">
        {theme === "system" ? "◐" : theme === "light" ? "☀" : "☾"}
      </span>
      {labels[theme]}
    </button>
  );
}
