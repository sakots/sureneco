export class BoardError extends Error {
  constructor(readonly code: string) {
    super("Board data unavailable.");
  }
}
export function validateDataUrl(url: string): void {
  if (
    /[\x00-\x20\x7f\\]/.test(url) ||
    !/^https:\/\/(?:[a-z0-9-]+\.)*5ch\.(?:io|net)\/[a-zA-Z0-9_]+\/(?:subject\.txt|dat\/[0-9]{9,11}\.dat)$/.test(
      url,
    )
  )
    throw new BoardError("invalid_url");
}
export async function fetchBoard(
  url: string,
  timeout = 15000,
  transport: typeof fetch = fetch,
): Promise<string> {
  validateDataUrl(url);
  if (timeout <= 0) throw new BoardError("fetch_timeout");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(15000, timeout));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await transport(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "User-Agent": "sureneco/server", Accept: "text/plain" },
    });
    if (!response.ok) throw new BoardError("http_error");
    if (!response.body) return "";
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5 * 1024 * 1024) throw new BoardError("response_too_large");
      chunks.push(value);
    }
    const data = Buffer.concat(chunks);
    let encoding = /utf-?8/i.test(response.headers.get("content-type") ?? "")
      ? "utf-8"
      : "shift_jis";
    if (data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
      encoding = "utf-8";
    if (data[0] === 0xff && data[1] === 0xfe) encoding = "utf-16le";
    if (data[0] === 0xfe && data[1] === 0xff) encoding = "utf-16be";
    return new TextDecoder(encoding).decode(data);
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError(
      controller.signal.aborted ? "fetch_timeout" : "fetch_failed",
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
}
