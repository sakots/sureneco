import type { Post, Recruitment, Settings } from "./types";
import { extractRoomIds, postReferences } from "./room-id";
export function isBlocked(post: Post, settings: Settings): boolean {
  return (
    settings.ng_words.some((x) => post.body.includes(x)) ||
    (!!post.id && settings.ng_ids.includes(post.id)) ||
    (!!post.watchoi && settings.ng_watchois.includes(post.watchoi))
  );
}
export function isRecent(
  post: Post | Recruitment,
  settings: Settings,
  now: number,
): boolean {
  const postedAt =
    "effectivePostedAt" in post ? post.effectivePostedAt : post.postedAt;
  return (
    postedAt > 0 &&
    now >= post.postedAt &&
    now >= postedAt &&
    now - postedAt <= settings.emphasis_sec * 1000
  );
}
export function scanPosts(
  threadId: string,
  posts: Post[],
  previous: Recruitment[],
  settings: Settings,
  now: number,
  sourcePosts: Post[] = posts,
) {
  const items = previous.map((x) => ({ ...x }));
  const added: Recruitment[] = [];
  const recruit =
    settings.recruitment_filter === "loose"
      ? undefined
      : new RegExp(settings.yujinsen_regex, "i");
  const close = new RegExp(settings.closed_yujinsen_regex, "i");
  const source = new Map(sourcePosts.map((post) => [post.number, post]));
  const closed = new Set(
    previous
      .filter((item) => item.threadId === threadId && item.closed)
      .map((item) => item.number),
  );
  // 履歴に残っていない募集にも、取得済みの締めレスを反映する。
  for (const closing of sourcePosts) {
    if (!close.test(closing.body)) continue;
    const refs = postReferences(closing.body);
    for (const target of sourcePosts) {
      if (target.number < closing.number && closesPost(closing, target, refs))
        closed.add(target.number);
    }
  }
  for (const post of posts) {
    if (close.test(post.body)) {
      const refs = postReferences(post.body);
      for (const item of items) {
        if (item.threadId !== threadId) continue;
        if (closesPost(post, item, refs)) {
          item.closed = true;
          closed.add(item.number);
        }
      }
    } else if (!isBlocked(post, settings)) {
      const { roomIds, matches, effectivePostedAt } = resolveRecruitment(
        post,
        source,
        settings,
        recruit,
        closed,
        now,
      );
      if (!matches || !roomIds.length) continue;
      const item = {
        ...post,
        roomIds,
        effectivePostedAt,
        threadId,
        closed: closed.has(post.number),
      };
      items.push(item);
      added.push(item);
    }
  }
  // 保存済みの返信も再評価するが、既存募集を新規通知には追加しない。
  for (let index = 0; index < previous.length; index++) {
    const item = items[index];
    if (item.threadId !== threadId) continue;
    const resolved = resolveRecruitment(
      item,
      source,
      settings,
      recruit,
      closed,
      now,
    );
    item.effectivePostedAt = resolved.effectivePostedAt;
    item.closed ||= closed.has(item.number) || resolved.referenceClosed;
  }
  return {
    items: items.slice(-200),
    notifications: added.filter(
      (x) =>
        !x.closed &&
        isRecent(x, settings, now) &&
        (!settings.allowed_watchois.length ||
          settings.allowed_watchois.includes(x.watchoi)),
    ),
  };
}

function closesPost(closing: Post, target: Post, refs: number[]): boolean {
  return refs.length
    ? refs.includes(target.number)
    : (!!closing.id && closing.id === target.id) ||
        (!!closing.watchoi && closing.watchoi === target.watchoi);
}

function resolveRecruitment(
  post: Post | Recruitment,
  source: Map<number, Post>,
  settings: Settings,
  pattern: RegExp | undefined,
  closed: Set<number>,
  now: number,
) {
  const direct = extractRoomIds(post.body);
  let matches = matchesRecruitment(post.body, direct, pattern);
  let effectivePostedAt =
    "effectivePostedAt" in post ? post.effectivePostedAt : post.postedAt;
  let referenceClosed = false;
  let referencesRecent = true;
  const roomIds = new Set<string>();
  const visited = new Set<string>();
  const pending: { post: Post; collect: boolean }[] = [];
  const enqueue = (current: Post, collect: boolean) => {
    for (const number of postReferences(current.body).reverse()) {
      if (number >= current.number) continue;
      const referenced = source.get(number);
      if (referenced) pending.push({ post: referenced, collect });
    }
  };
  enqueue(post, !direct.length);
  while (pending.length) {
    const { post: referenced, collect } = pending.pop()!;
    const key = `${referenced.number}:${collect}`;
    if (visited.has(key)) continue;
    visited.add(key);
    referenceClosed ||= closed.has(referenced.number);
    referencesRecent &&= isRecent(referenced, settings, now);
    if (isBlocked(referenced, settings)) continue;
    effectivePostedAt = Math.min(effectivePostedAt, referenced.postedAt);
    const ids = extractRoomIds(referenced.body);
    if (collect) {
      matches ||= matchesRecruitment(referenced.body, ids, pattern);
      ids.forEach((id) => roomIds.add(id));
    }
    enqueue(referenced, collect && !ids.length);
  }
  return {
    roomIds: direct.length ? direct : [...roomIds],
    matches: matches && referencesRecent && !referenceClosed,
    effectivePostedAt,
    referenceClosed,
  };
}

const loosePlayers = /(?<![0-9０-９])[34３４三四](?![0-9０-９])/u;
const looseRound = /[東南]/u;

function matchesRecruitment(
  body: string,
  roomIds: string[],
  pattern: RegExp | undefined,
): boolean {
  return pattern
    ? pattern.test(body)
    : roomIds.length > 0 && loosePlayers.test(body) && looseRound.test(body);
}
