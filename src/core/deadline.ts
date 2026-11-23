import type { Post, Recruitment, Settings } from "./types";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const jstMs = 9 * hourMs;
export const defaultDeadlineSuffix = String.raw`まで|(?:で|に)?\s*(?:締(?:め)?(?:切(?:り|る)?)?|〆(?:切り?)?|しめきり|爆破|ちんぽにゃ)`;
const timePattern =
  /(?<![0-9０-９.．+＋\-－])(?:(?<hour>[0-9０-９]{1,2})\s*(?:時(?:\s*(?<minute>[0-9０-９]{1,2})\s*分)?|[:：]\s*(?<colonMinute>[0-9０-９]{1,2}))|(?:(?<remaining>あと|残り)\s*)?(?<minuteOnly>[0-9０-９]{1,4})\s*分(?<relative>\s*後)?)\s*/u;
const timeGroupNames = Object.keys(
  new RegExp(`|${timePattern.source}`, "u").exec("")!.groups!,
);

export function compileDeadlinePattern(suffix = defaultDeadlineSuffix): RegExp {
  // The first empty alternative exposes named groups without running the suffix.
  // QuickJS accepts duplicate names, but they must not shadow the numeric captures.
  const groups = new RegExp(`|${suffix}`, "iu").exec("")?.groups;
  if (groups && timeGroupNames.some((name) => Object.hasOwn(groups, name))) {
    throw new SyntaxError("Deadline suffix uses a reserved capture group name");
  }
  return new RegExp(`${timePattern.source}(?:${suffix})`, "giu");
}

const deadlinePattern = compileDeadlinePattern();

export function parseDeadline(
  post: Pick<Post, "body" | "postedAt">,
  pattern = deadlinePattern,
): {
  deadlineAt: number;
  closingBody: string;
} | null {
  if (!Number.isSafeInteger(post.postedAt) || post.postedAt <= 0) return null;
  let earliest = Infinity;
  const parts: string[] = [];
  let offset = 0;
  for (const match of post.body.matchAll(pattern)) {
    // Past-tense closures remain real closing posts, not future promises.
    if (
      /^\s*(?:ました|った|た|済)/u.test(
        post.body.slice(match.index + match[0].length),
      )
    )
      continue;
    const groups = match.groups!;
    const number = (text: string) => Number(text.normalize("NFKC"));
    let at: number;
    if (groups.hour !== undefined) {
      const hour = number(groups.hour);
      const minute = number(groups.minute ?? groups.colonMinute ?? "0");
      if (hour > 23 || minute > 59) continue;
      const midnight =
        Math.floor((post.postedAt + jstMs) / dayMs) * dayMs - jstMs;
      at = midnight + hour * hourMs + minute * minuteMs;
      // Only an unambiguous overnight time rolls forward; recent past stays past.
      if (at < post.postedAt - 12 * hourMs) at += dayMs;
    } else {
      const minute = number(groups.minuteOnly);
      if (groups.relative !== undefined || groups.remaining !== undefined) {
        at = post.postedAt + minute * minuteMs;
      } else {
        if (minute > 59) continue;
        at = Math.floor(post.postedAt / hourMs) * hourMs + minute * minuteMs;
        if (minute < Math.floor(post.postedAt / minuteMs) % 60) at += hourMs;
      }
    }
    if (!Number.isSafeInteger(at)) continue;
    earliest = Math.min(earliest, at);
    parts.push(post.body.slice(offset, match.index), " ");
    offset = match.index + match[0].length;
  }
  if (earliest === Infinity) return null;
  parts.push(post.body.slice(offset));
  return { deadlineAt: earliest, closingBody: parts.join("") };
}

export function recruitmentExpiresAt(
  post: Post | Recruitment,
  settings: Pick<Settings, "emphasis_sec"> &
    Partial<Pick<Settings, "recruitment_deadline_regex">>,
  pattern = compileDeadlinePattern(settings.recruitment_deadline_regex),
): number {
  const explicit =
    ("deadlineAt" in post ? post.deadlineAt : undefined) ??
    parseDeadline(post, pattern)?.deadlineAt;
  const anchor =
    "effectivePostedAt" in post ? post.effectivePostedAt : post.postedAt;
  return explicit ?? anchor + settings.emphasis_sec * 1000;
}

export function isClosingPost(
  post: Post,
  pattern: RegExp,
  deadline = deadlinePattern,
): boolean {
  return pattern.test(parseDeadline(post, deadline)?.closingBody ?? post.body);
}
