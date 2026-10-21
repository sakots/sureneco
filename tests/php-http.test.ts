import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const maximumBytes = 5 * 1024 * 1024;
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function server(handler: RequestListener) {
  const listener = createServer(handler);
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  cleanup.push(async () => {
    const closed = once(listener, "close");
    listener.close();
    listener.closeAllConnections();
    await closed;
  });
  const address = listener.address();
  if (address === null || typeof address === "string") {
    throw new Error("Missing loopback port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function php(input: Record<string, unknown>) {
  const running = execute(
    "php",
    [
      "-r",
      `require 'server/http.php';
      $input = json_decode(stream_get_contents(STDIN), true, 64, JSON_THROW_ON_ERROR);
      try {
        if ($input['operation'] === 'validate') {
          Sureneco\\validateBoardDataUrl($input['url']);
          $result = null;
        } elseif ($input['operation'] === 'fetch') {
          $result = Sureneco\\fetchBoardData($input['url'], $input['timeoutMs']);
        } else {
          // Only the internal consumer sees a local URL: production fetch has no override.
          $handle = curl_init($input['url']);
          curl_setopt_array($handle, [CURLOPT_TIMEOUT_MS => $input['timeoutMs'] ?? 1000, CURLOPT_PROXY => '']);
          $result = Sureneco\\consumeBoardResponse($handle);
          if ($input['summary'] ?? false) $result = strlen($result);
          unset($handle);
        }
        echo json_encode(['ok' => true, 'result' => $result], JSON_THROW_ON_ERROR);
      } catch (Sureneco\\BoardFetchException $error) {
        echo json_encode(['ok' => false, 'error' => $error->errorCode], JSON_THROW_ON_ERROR);
      }`,
    ],
    { cwd: root, timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  running.child.stdin!.end(JSON.stringify(input));
  const { stdout, stderr } = await running;
  expect(stderr).toBe("");
  return JSON.parse(stdout);
}

it("allows only HTTPS 5ch subject/dat paths, including an explicit default port", async () => {
  for (const url of [
    "https://5ch.io/mj/subject.txt",
    "https://5ch.net/mj/subject.txt",
    "HTTPS://Egg.5ch.IO:443/Board_123/subject.txt",
    "https://egg.5ch.net/mj/dat/123456789.dat",
    "https://egg.5ch.io/mj/dat/12345678901.dat",
  ]) {
    expect(await php({ operation: "validate", url })).toEqual({
      ok: true,
      result: null,
    });
  }
});

it("rejects alternate destinations, credentials, metadata and raw or encoded traversal before fetching", async () => {
  for (const url of [
    "http://egg.5ch.io/mj/subject.txt",
    "file:///mj/subject.txt",
    "https://127.0.0.1/mj/subject.txt",
    "https://5ch.io.evil.example/mj/subject.txt",
    "https://evil5ch.io/mj/subject.txt",
    "https://egg.5ch.io./mj/subject.txt",
    "https://user@egg.5ch.io/mj/subject.txt",
    "https://@egg.5ch.io/mj/subject.txt",
    "https://user:secret@egg.5ch.io/mj/subject.txt",
    "https://egg.5ch.io:444/mj/subject.txt",
    "https://egg.5ch.io/mj/subject.txt?",
    "https://egg.5ch.io/mj/subject.txt?x=1",
    "https://egg.5ch.io/mj/subject.txt#",
    "https://egg.5ch.io/mj/subject.txt#fragment",
    "https://egg.5ch.io/mj/../mj/subject.txt",
    "https://egg.5ch.io/mj/./subject.txt",
    "https://egg.5ch.io/mj/%2e%2e/mj/subject.txt",
    "https://egg.5ch.io/mj%2f..%2fmj/subject.txt",
    "https://egg.5ch.io/mj\\subject.txt",
    "https://egg.5ch.io/mj/subject.txt\n",
    "https://egg.5ch.io//mj/subject.txt",
    "https://egg.5ch.io/mj/Subject.txt",
    "https://egg.5ch.io/mj/subject.txt/",
    "https://egg.5ch.io/mj/dat/not-a-thread.dat",
    "https://egg.5ch.io/mj/dat/12345678.dat",
    "https://egg.5ch.io/mj/dat/123456789012.dat",
    "https://egg.5ch.io/mj/dat/123456789.DAT",
    "https://egg.5ch.io/mj/read.cgi/123456789",
  ]) {
    // Even a zero budget cannot bypass URL validation, and no network is used.
    expect(await php({ operation: "fetch", url, timeoutMs: 0 })).toEqual({
      ok: false,
      error: "invalid_url",
    });
  }
});

it("fails immediately when the caller's remaining batch budget is exhausted", async () => {
  for (const timeoutMs of [0, -1]) {
    expect(
      await php({
        operation: "fetch",
        url: "https://egg.5ch.io/mj/subject.txt",
        timeoutMs,
      }),
    ).toEqual({ ok: false, error: "fetch_timeout" });
  }
});

it("decodes declared UTF-8/utf8 and otherwise CP932, replacing malformed bytes", async () => {
  const cases = [
    {
      type: "text/plain; charset=UTF-8",
      body: Buffer.from("雀魂"),
      text: "雀魂",
    },
    {
      type: "text/plain; charset=utf8",
      body: Buffer.from("雀魂"),
      text: "雀魂",
    },
    {
      type: "text/plain; charset=Shift_JIS",
      body: Buffer.from([0x90, 0x9d, 0x8d, 0xb0, 0x87, 0x40]),
      text: "雀魂①",
    },
    { body: Buffer.from([0x90, 0x9d, 0x8d, 0xb0]), text: "雀魂" },
    {
      type: "text/plain; charset=UTF-8",
      body: Buffer.from([0x61, 0xff, 0x62]),
      text: "a\ufffdb",
    },
    { body: Buffer.from([0x82]), text: "\ufffd" },
    { body: Buffer.from("\ufeff雀魂"), text: "雀魂" },
    {
      type: "text/plain; charset=UTF-8",
      body: Buffer.from([0xff, 0xfe, 0x41, 0x00]),
      text: "A",
    },
  ];
  const url = await server((request, response) => {
    const fixture = cases[Number(request.url!.slice(1))];
    if (fixture.type) response.setHeader("Content-Type", fixture.type);
    response.end(fixture.body);
  });
  for (const [index, fixture] of cases.entries()) {
    expect(await php({ operation: "consume", url: `${url}/${index}` })).toEqual(
      {
        ok: true,
        result: fixture.text,
      },
    );
  }
});

it("accepts the exact 5MiB boundary and empty 2xx responses", async () => {
  const url = await server((request, response) => {
    if (request.url === "/empty") {
      response.writeHead(204).end();
    } else {
      response.setHeader("Content-Length", maximumBytes);
      response.end(Buffer.alloc(maximumBytes, 0x61));
    }
  });
  expect(await php({ operation: "consume", url, summary: true })).toEqual({
    ok: true,
    result: maximumBytes,
  });
  expect(await php({ operation: "consume", url: `${url}/empty` })).toEqual({
    ok: true,
    result: "",
  });
});

it("aborts oversized Content-Length and unfinished chunked responses as soon as bytes exceed 5MiB", async () => {
  const url = await server((request, response) => {
    if (request.url === "/length") {
      response.setHeader("Content-Length", maximumBytes + 1);
      response.end(Buffer.alloc(maximumBytes + 1, 0x61));
      return;
    }
    // No Content-Length and deliberately no end: waiting for a complete body must fail this test.
    response.setHeader("Transfer-Encoding", "chunked");
    const chunk = Buffer.alloc(65536, 0x61);
    for (let offset = 0; offset < maximumBytes; offset += chunk.length) {
      response.write(chunk);
    }
    response.write("a");
  });
  for (const path of ["/length", "/chunked"]) {
    expect(
      await php({ operation: "consume", url: `${url}${path}`, summary: true }),
    ).toEqual({ ok: false, error: "response_too_large" });
  }
});

it("rejects redirects without following Location and rejects other non-2xx statuses", async () => {
  let destinationRequests = 0;
  const url = await server((request, response) => {
    if (request.url === "/destination") {
      destinationRequests += 1;
      response.end("must not be fetched");
      return;
    }
    const status = Number(request.url!.slice(1));
    if (status >= 300 && status < 400) {
      response.setHeader("Location", "/destination");
    }
    response.writeHead(status).end("error");
  });
  for (const status of [301, 302, 307, 308, 400, 403, 404, 429, 500, 503]) {
    expect(
      await php({ operation: "consume", url: `${url}/${status}` }),
    ).toEqual({
      ok: false,
      error: "http_error",
    });
  }
  expect(destinationRequests).toBe(0);
});

it("reports cURL timeouts and truncated bodies rather than returning partial data", async () => {
  const url = await server((request, response) => {
    if (request.url === "/timeout") {
      response.writeHead(200);
      response.write("partial");
      return;
    }
    response.setHeader("Content-Length", 100);
    response.setHeader("Connection", "close");
    response.end("partial");
  });
  expect(
    await php({ operation: "consume", url: `${url}/timeout`, timeoutMs: 50 }),
  ).toEqual({ ok: false, error: "fetch_timeout" });
  expect(await php({ operation: "consume", url: `${url}/truncated` })).toEqual({
    ok: false,
    error: "fetch_failed",
  });
});
