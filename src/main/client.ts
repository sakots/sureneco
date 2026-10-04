import { boardUrl, validThreadId } from "../core/settings";
const MAX_BYTES = 5 * 1024 * 1024;
export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    headers: { "User-Agent": "sureneco/0.1.0", Accept: "text/plain" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("レスポンスが空です。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("取得データが5MiBを超えています。");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(
    response.headers.get("content-type") ?? "",
  )?.[1];
  return new TextDecoder(
    charset && /utf-?8/i.test(charset) ? "utf-8" : "shift_jis",
  ).decode(bytes);
}
export const client = {
  subject: (url: string) => fetchText(`${boardUrl(url)}subject.txt`),
  dat: (url: string, id: string) => {
    if (!validThreadId(id)) throw new Error("スレッド番号が不正です。");
    return fetchText(`${boardUrl(url)}dat/${id}.dat`);
  },
};
