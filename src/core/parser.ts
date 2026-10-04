import type { Post, Settings, Thread } from "./types";
export function plainText(html: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (_, key: string) => {
        if (key[0] !== "#") return entities[key.toLowerCase()] ?? "";
        const n =
          key[1].toLowerCase() === "x"
            ? parseInt(key.slice(2), 16)
            : Number(key.slice(1));
        return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�";
      },
    )
    .trim();
}
export function parseSubject(text: string): Thread[] {
  const result: Thread[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{9,11})\.dat<>(.*?)\s*\((\d+)\)\s*$/.exec(line);
    if (m)
      result.push({
        id: m[1],
        title: plainText(m[2]),
        count: Number(m[3]),
        createdAt: Number(m[1]) * 1000,
      });
  }
  if (text.trim() && !result.length)
    throw new Error("スレッド一覧の取得形式が不正です。");
  return result;
}
export function candidates(
  threads: Thread[],
  settings: Settings,
  now: number,
): Thread[] {
  const include = new RegExp(settings.thread_title_regex, "i");
  const exclude = settings.ng_thread_title_regex
    ? new RegExp(settings.ng_thread_title_regex, "i")
    : null;
  return threads.filter(
    (t) =>
      include.test(t.title) &&
      !exclude?.test(t.title) &&
      t.createdAt <= now &&
      now - t.createdAt <= settings.elapsed_days * 86400000,
  );
}
export function parseDat(text: string): Post[] {
  if (!text.trim()) return [];
  return text
    .trimEnd()
    .split(/\r?\n/)
    .map((line, index) => {
      const fields = line.split("<>");
      if (fields.length < 5) throw new Error("レスの取得形式が不正です。");
      const name = plainText(fields[0]);
      const date = plainText(fields[2]);
      const m =
        /(\d{4})\/(\d{2})\/(\d{2}).*?(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(
          date,
        );
      const postedAt = m
        ? Date.parse(
            `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${(m[7] ?? "0").padEnd(3, "0").slice(0, 3)}+09:00`,
          )
        : 0;
      return {
        number: index + 1,
        name,
        id: /ID:([^\s]+)/.exec(date)?.[1] ?? "",
        watchoi:
          /[（(]((?:ﾜｯﾁｮｲ|ｱｳｱｳ|ｻｻ|ｽﾌﾟ|ｵｯﾍﾟｹ|ﾌﾞｰｲﾓ|ﾃﾃﾝ|ｴﾑｿﾞﾈ|ｱｰｸｾｰ|JP|IP)[^）)]*)[）)]/.exec(
            name,
          )?.[1] ?? "",
        body: plainText(fields[3]),
        postedAt: Number.isFinite(postedAt) ? postedAt : 0,
      };
    });
}
