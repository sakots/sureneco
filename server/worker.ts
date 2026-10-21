import { scanPosts } from "../src/core/detection";
import { candidates, parseDat, parseSubject } from "../src/core/parser";
import type { Post, Recruitment, Settings } from "../src/core/types";

// This module is embedded in the native worker. Request values are data, never code.
export function run(json: string): string {
  try {
    const input = JSON.parse(json) as {
      operation: string;
      patterns?: unknown;
      threadId: string;
      posts: Post[];
      previous: Recruitment[];
      settings: Settings;
      now: number;
      sourcePosts?: Post[];
      dat?: unknown;
      subject?: unknown;
      watched?: unknown;
      trackPending?: boolean;
    };
    if (!input || typeof input !== "object") {
      return JSON.stringify({ ok: false, error: "invalid_request" });
    }
    let patterns: unknown;
    if (input.operation === "dat") {
      if (typeof input.dat !== "string") {
        return JSON.stringify({ ok: false, error: "invalid_request" });
      }
      return JSON.stringify({ ok: true, result: parseDat(input.dat) });
    }
    if (input.operation === "validate") {
      patterns = input.patterns;
    } else if (input.operation === "scan") {
      if (
        typeof input.threadId !== "string" ||
        !/^\d{9,11}$/.test(input.threadId) ||
        !Array.isArray(input.posts) ||
        !Array.isArray(input.previous) ||
        !Number.isSafeInteger(input.now) ||
        !input.settings ||
        typeof input.settings !== "object" ||
        (input.trackPending !== undefined &&
          typeof input.trackPending !== "boolean") ||
        (input.sourcePosts !== undefined && !Array.isArray(input.sourcePosts))
      ) {
        return JSON.stringify({ ok: false, error: "invalid_request" });
      }
      patterns = [
        input.settings.yujinsen_regex,
        input.settings.closed_yujinsen_regex,
      ];
    } else if (input.operation === "subject") {
      if (
        typeof input.subject !== "string" ||
        !Array.isArray(input.watched) ||
        input.watched.some(
          (id) => typeof id !== "string" || !/^\d{9,11}$/.test(id),
        ) ||
        !Number.isSafeInteger(input.now) ||
        !input.settings ||
        typeof input.settings !== "object" ||
        !Number.isSafeInteger(input.settings.elapsed_days) ||
        input.settings.elapsed_days < 1
      ) {
        return JSON.stringify({ ok: false, error: "invalid_request" });
      }
      patterns = [
        input.settings.thread_title_regex,
        input.settings.ng_thread_title_regex,
      ];
    } else {
      return JSON.stringify({ ok: false, error: "invalid_request" });
    }
    if (
      !Array.isArray(patterns) ||
      patterns.length > 4 ||
      patterns.some(
        (pattern) => typeof pattern !== "string" || pattern.length > 1000,
      )
    ) {
      return JSON.stringify({ ok: false, error: "invalid_request" });
    }
    for (const pattern of patterns) {
      try {
        new RegExp(pattern, "i");
      } catch (error) {
        if (error instanceof SyntaxError) {
          return JSON.stringify({ ok: false, error: "invalid_pattern" });
        }
        throw error;
      }
    }
    if (input.operation === "subject") {
      const threads = parseSubject(input.subject as string);
      const watched = new Set(input.watched as string[]);
      const eligible = new Set(candidates(threads, input.settings, input.now));
      return JSON.stringify({
        ok: true,
        result: threads.filter(
          (thread) => watched.has(thread.id) || eligible.has(thread),
        ),
      });
    }
    const result =
      input.operation === "validate"
        ? null
        : scanPosts(
            input.threadId,
            input.posts,
            input.previous,
            input.settings,
            input.now,
            input.sourcePosts,
          );
    if (input.operation === "scan" && input.trackPending && result !== null) {
      // UI history is capped at 200; delivery must cancel every known pending event.
      const close = new RegExp(input.settings.closed_yujinsen_regex, "i");
      const closing = input.posts.filter((post) => close.test(post.body));
      const closedPrevious: number[] = [];
      for (let offset = 0; offset < input.previous.length; offset += 200) {
        const pending = scanPosts(
          input.threadId,
          closing,
          input.previous.slice(offset, offset + 200),
          input.settings,
          input.now,
          [],
        );
        for (const item of pending.items) {
          if (item.closed) closedPrevious.push(item.number);
        }
      }
      return JSON.stringify({
        ok: true,
        result: { ...result, closedPrevious },
      });
    }
    return JSON.stringify({ ok: true, result });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error:
        error === null ||
        (error instanceof Error &&
          (error.name === "InternalError" || error instanceof RangeError))
          ? "execution_limit"
          : "invalid_request",
    });
  }
}
