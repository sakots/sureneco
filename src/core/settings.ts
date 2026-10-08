import type { Settings } from "./types";
export const defaults: Settings = {
  update_sec: 20,
  elapsed_days: 14,
  emphasis_sec: 600,
  thread_title_regex: "雀魂|じゃんたま|ジャンタマ|mahjongsoul|majsoul",
  ng_thread_title_regex: "",
  yujinsen_regex:
    "友人戦|友人部屋|(?:募集|部屋)[\\s:：]*[0-9０-９]{5,6}|[0-9０-９]{5,6}[\\s　]*(?:募|＠|@)|四東|四南|三東|三南|(?<![0-9０-９IVXLCDMⅠ-Ⅻⅰ-ⅻ])(?:[34３４]|III|IV|Ⅲ|Ⅳ)[東南]",
  closed_yujinsen_regex: "〆|締め|しめ|締切|締め切|解散|埋まり|満員",
  url: "https://egg.5ch.io/mj/",
  ng_words: [],
  ng_ids: [],
  ng_watchois: [],
  allowed_watchois: [],
  launcher_mode: "default",
  launcher_path: "",
  launcher_args: [],
  launcher_profile: "",
  launcher_user_data_dir: "",
};
export function boardUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !/^(?:[a-z0-9-]+\.)*5ch\.(?:io|net)$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[a-zA-Z0-9_]+\/?$/.test(url.pathname)
  ) {
    throw new Error("URLは5ch.io / 5ch.netのHTTPSの板URLを指定してください。");
  }
  return `${url.origin}${url.pathname.replace(/\/?$/, "/")}`;
}
export function validateSettings(input: unknown): Settings {
  if (!input || typeof input !== "object") throw new Error("設定が不正です。");
  const value = input as Record<string, unknown>;
  const result = {} as Settings;
  for (const key of ["update_sec", "elapsed_days", "emphasis_sec"] as const) {
    const n = value[key];
    if (
      typeof n !== "number" ||
      !Number.isSafeInteger(n) ||
      n < (key === "update_sec" ? 20 : 1) ||
      n > 2147483
    )
      throw new Error(
        `${key}は${key === "update_sec" ? 20 : 1}以上2147483以下の整数にしてください。`,
      );
    result[key] = n;
  }
  for (const key of [
    "thread_title_regex",
    "ng_thread_title_regex",
    "yujinsen_regex",
    "closed_yujinsen_regex",
  ] as const) {
    const pattern = value[key];
    if (
      typeof pattern !== "string" ||
      pattern.length > 1000 ||
      (key !== "ng_thread_title_regex" && !pattern.trim())
    )
      throw new Error(`${key}の入力が不正です。`);
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new Error(`${key}の正規表現が不正です。`);
    }
    result[key] = pattern;
  }
  if (typeof value.url !== "string") throw new Error("板URLが不正です。");
  result.url = boardUrl(value.url);
  for (const key of [
    "ng_words",
    "ng_ids",
    "ng_watchois",
    "allowed_watchois",
  ] as const) {
    const list =
      key === "allowed_watchois" && value[key] === undefined ? [] : value[key];
    if (
      !Array.isArray(list) ||
      list.length > 1000 ||
      list.some((x) => typeof x !== "string" || x.length > 500)
    )
      throw new Error(`${key}の入力が不正です。`);
    result[key] = [...new Set(list.map((x) => x.trim()).filter(Boolean))];
  }
  const mode =
    value.launcher_mode === undefined
      ? defaults.launcher_mode
      : value.launcher_mode;
  if (mode !== "default" && mode !== "browser" && mode !== "application")
    throw new Error("雀魂の起動方法が不正です。");
  result.launcher_mode = mode;
  for (const key of [
    "launcher_path",
    "launcher_profile",
    "launcher_user_data_dir",
  ] as const) {
    const text = value[key] === undefined ? defaults[key] : value[key];
    if (typeof text !== "string" || text.length > 4096 || /[\0\r\n]/.test(text))
      throw new Error("雀魂の起動設定が不正です。");
    result[key] = text.trim();
  }
  const absolutePath = (path: string) =>
    /^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\]+\\)/.test(path);
  if (
    (mode !== "default" && !result.launcher_path) ||
    (result.launcher_path && !absolutePath(result.launcher_path))
  )
    throw new Error("実行ファイルはフルパスで指定してください。");
  if (
    result.launcher_user_data_dir &&
    !absolutePath(result.launcher_user_data_dir)
  )
    throw new Error(
      "ユーザーデータディレクトリーはフルパスで指定してください。",
    );
  if (
    result.launcher_profile &&
    (/[/\\]/.test(result.launcher_profile) ||
      [".", ".."].includes(result.launcher_profile))
  )
    throw new Error(
      "プロファイルにはDefaultやProfile 1などのディレクトリー名を指定してください。",
    );
  const args = value.launcher_args === undefined ? [] : value.launcher_args;
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    args.some(
      (arg) =>
        typeof arg !== "string" || arg.length > 4096 || /[\0\r\n]/.test(arg),
    )
  )
    throw new Error("起動引数は一行に一つ、64個以内で指定してください。");
  result.launcher_args = args.map((arg) => arg.trim()).filter(Boolean);
  return result;
}
export function validThreadId(id: unknown): id is string {
  return typeof id === "string" && /^\d{9,11}$/.test(id);
}
export function threadUrl(board: string, id: string, post?: number): string {
  if (
    !validThreadId(id) ||
    (post !== undefined && (!Number.isSafeInteger(post) || post < 1))
  )
    throw new Error("スレッド番号が不正です。");
  const url = new URL(boardUrl(board));
  return `${url.origin}/test/read.cgi${url.pathname}${id}/${post ?? ""}`;
}
