import { scanPosts } from "../src/core/detection";
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
    };
    if (!input || typeof input !== "object") {
      return JSON.stringify({ ok: false, error: "invalid_request" });
    }
    let patterns: unknown;
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
        (input.sourcePosts !== undefined && !Array.isArray(input.sourcePosts))
      ) {
        return JSON.stringify({ ok: false, error: "invalid_request" });
      }
      patterns = [
        input.settings.yujinsen_regex,
        input.settings.closed_yujinsen_regex,
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
