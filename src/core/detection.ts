import type { Post, Recruitment, Settings } from "./types";
import { extractRoomIds, postReferences } from "./room-id";
export function isBlocked(post: Post, settings: Settings): boolean {
  return (
    settings.ng_words.some((x) => post.body.includes(x)) ||
    (!!post.id && settings.ng_ids.includes(post.id)) ||
    (!!post.watchoi && settings.ng_watchois.includes(post.watchoi))
  );
}
export function isRecent(post: Post, settings: Settings, now: number): boolean {
  return (
    post.postedAt > 0 &&
    now >= post.postedAt &&
    now - post.postedAt <= settings.emphasis_sec * 1000
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
  const recruit = new RegExp(settings.yujinsen_regex, "i");
  const close = new RegExp(settings.closed_yujinsen_regex, "i");
  const source = new Map(sourcePosts.map((post) => [post.number, post]));
  for (const post of posts) {
    if (close.test(post.body)) {
      const refs = postReferences(post.body);
      for (const item of items) {
        if (item.threadId !== threadId) continue;
        const sameAuthor =
          (!!post.id && post.id === item.id) ||
          (!!post.watchoi && post.watchoi === item.watchoi);
        if (refs.length ? refs.includes(item.number) : sameAuthor)
          item.closed = true;
      }
    } else if (!isBlocked(post, settings)) {
      const { roomIds, matches } = resolveRecruitment(
        post,
        source,
        settings,
        recruit,
      );
      if (!matches || !roomIds.length) continue;
      const item = { ...post, roomIds, threadId, closed: false };
      items.push(item);
      added.push(item);
    }
  }
  return {
    items: items.slice(-200),
    notifications: added.filter((x) => !x.closed && isRecent(x, settings, now)),
  };
}

function resolveRecruitment(
  post: Post,
  source: Map<number, Post>,
  settings: Settings,
  pattern: RegExp,
) {
  const direct = extractRoomIds(post.body);
  let matches = pattern.test(post.body);
  if (direct.length) return { roomIds: direct, matches };
  const roomIds = new Set<string>();
  const visited = new Set<number>([post.number]);
  const pending: Post[] = [];
  const enqueue = (current: Post) => {
    for (const number of postReferences(current.body).reverse()) {
      if (number >= current.number) continue;
      const referenced = source.get(number);
      if (referenced) pending.push(referenced);
    }
  };
  enqueue(post);
  while (pending.length) {
    const referenced = pending.pop()!;
    if (visited.has(referenced.number)) continue;
    visited.add(referenced.number);
    if (isBlocked(referenced, settings)) continue;
    matches ||= pattern.test(referenced.body);
    const ids = extractRoomIds(referenced.body);
    if (ids.length) ids.forEach((id) => roomIds.add(id));
    else enqueue(referenced);
  }
  return { roomIds: [...roomIds], matches };
}
