import type { Post, Recruitment, Settings } from "./types";
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
) {
  const items = previous.map((x) => ({ ...x }));
  const added: Recruitment[] = [];
  const recruit = new RegExp(settings.yujinsen_regex, "i");
  const close = new RegExp(settings.closed_yujinsen_regex, "i");
  for (const post of posts) {
    if (close.test(post.body)) {
      const refs = [...post.body.matchAll(/>>\s*(\d+)/g)].map((x) =>
        Number(x[1]),
      );
      for (const item of items) {
        if (item.threadId !== threadId) continue;
        const sameAuthor =
          (!!post.id && post.id === item.id) ||
          (!!post.watchoi && post.watchoi === item.watchoi);
        if (refs.length ? refs.includes(item.number) : sameAuthor)
          item.closed = true;
      }
    } else if (recruit.test(post.body) && !isBlocked(post, settings)) {
      const item = { ...post, threadId, closed: false };
      items.push(item);
      added.push(item);
    }
  }
  return {
    items: items.slice(-200),
    notifications: added.filter((x) => !x.closed && isRecent(x, settings, now)),
  };
}
