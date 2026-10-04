import { readFile } from "node:fs/promises";
const css = await readFile(
  new URL("../src/renderer/style.css", import.meta.url),
  "utf8",
);
const roots = [...css.matchAll(/:root\s*\{([^}]+)\}/g)];
function luminance(hex) {
  const rgb = hex
    .match(/[a-f0-9]{2}/gi)
    .map((c) => parseInt(c, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
if (roots.length !== 2) throw new Error("明暗テーマが必要です。");
for (const [index, root] of roots.entries()) {
  const vars = Object.fromEntries(
    [...root[1].matchAll(/--([\w-]+):\s*(#[a-f0-9]{6})/gi)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  for (const [fg, bg] of [
    ["text", "bg"],
    ["text", "panel"],
    ["muted", "bg"],
    ["muted", "panel"],
    ["accent", "soft"],
    ["accent-text", "accent"],
    ["error-text", "error-bg"],
  ]) {
    const a = luminance(vars[fg]),
      b = luminance(vars[bg]);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 4.5)
      throw new Error(
        `${index ? "dark" : "light"} ${fg}/${bg}: ${ratio.toFixed(2)} < 4.5`,
      );
  }
  console.log(
    `${index ? "dark" : "light"}: 本文・補足・ボタン・エラーのコントラスト合格`,
  );
}
if (!css.includes(":focus-visible") || !css.includes("prefers-reduced-motion"))
  throw new Error("フォーカス表示と動きの軽減が必要です。");
