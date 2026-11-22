import { recruitmentExpiresAt } from "../../../src/core/deadline";
import { scanPosts } from "../../../src/core/detection";
import { candidates, parseDat, parseSubject } from "../../../src/core/parser";
import { defaults, validThreadId } from "../../../src/core/settings";
import type { Post, Thread } from "../../../src/core/types";

type ErrorCode =
  | "invalid_request"
  | "invalid_subject"
  | "invalid_dat"
  | "execution_limit"
  | "execution_failed";

function failure(error: ErrorCode): string {
  return JSON.stringify({ ok: false, error });
}

function isExecutionLimit(error: unknown): boolean {
  return (
    error === null ||
    error instanceof RangeError ||
    (error instanceof Error && error.name === "InternalError")
  );
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Invoked once by the isolated native worker. Request values are data, not code.
export function run(json: string): string {
  try {
    const input: unknown = JSON.parse(json);
    if (!input || typeof input !== "object" || Array.isArray(input))
      return failure("invalid_request");
    const { operation, text, now, threadId, after, filter } = input as Record<
      string,
      unknown
    >;
    if (typeof text !== "string" || !nonnegativeInteger(now))
      return failure("invalid_request");

    if (operation === "list") {
      let threads: Thread[];
      try {
        threads = parseSubject(text);
      } catch (error) {
        return failure(
          isExecutionLimit(error) ? "execution_limit" : "invalid_subject",
        );
      }
      return JSON.stringify({
        ok: true,
        result: { threads: candidates(threads, defaults, now) },
      });
    }

    if (
      operation !== "scan" ||
      !validThreadId(threadId) ||
      (after !== null && !nonnegativeInteger(after)) ||
      (filter !== "regex" && filter !== "loose")
    )
      return failure("invalid_request");

    let posts: Post[];
    try {
      posts = parseDat(text);
    } catch (error) {
      return failure(
        isExecutionLimit(error) ? "execution_limit" : "invalid_dat",
      );
    }
    const lastPost = posts.length;
    if (!lastPost) return failure("invalid_dat");
    const settings = { ...defaults, recruitment_filter: filter } as const;
    const recruitments =
      after === null || after >= lastPost
        ? []
        : scanPosts(
            threadId,
            posts.slice(after),
            [],
            settings,
            now,
            posts,
          ).notifications.map((item) => ({
            ...item,
            expiresAt: recruitmentExpiresAt(item, settings),
          }));
    return JSON.stringify({ ok: true, result: { lastPost, recruitments } });
  } catch (error) {
    return failure(
      isExecutionLimit(error)
        ? "execution_limit"
        : error instanceof SyntaxError
          ? "invalid_request"
          : "execution_failed",
    );
  }
}
