/**
 * Home feed: hybrid fan-out.
 *
 * Write side (image worker, after a post is published):
 *   - Regular authors: push the post id into each follower's cached timeline, in pipelined
 *     batches of FEED_FANOUT_BATCH_SIZE followers, paging the follower list by keyset.
 *   - Authors with >= FEED_CELEBRITY_THRESHOLD followers: no fan-out at all. One post would
 *     otherwise cost millions of Redis writes; instead followers pull these posts at read time.
 *
 * Read side (GET /api/v1/feed):
 *   timeline page (pushed posts)  +  recent posts of followed celebrities (pulled)
 *   -> merge by (created_ms DESC, id DESC) -> hydrate the page in one SQL round trip.
 *
 * The timeline is a cache: a missing timeline is rebuilt from PostgreSQL, and a reader who
 * scrolls past its 500-entry cap continues from PostgreSQL with the same cursor.
 */
import { query } from './db.js';
import config from '../config/index.js';
import logger from './logger.js';
import {
  readTimeline,
  isTimelineBuilt,
  markTimelineBuilt,
  unmarkTimelineBuilt,
  mergeIntoTimeline,
  touchTimeline,
  addToCachedTimelines,
  removeFromTimelines,
  TimelineEntry,
  FeedCursor,
} from './timeline.js';
import { feedFanoutTotal, feedFanoutTimelineWrites } from './metrics.js';

export type { FeedCursor, TimelineEntry } from './timeline.js';

export interface FeedMedia {
  id: string;
  mediaType: string;
  mediaUrl: string;
  thumbnailUrl: string | null;
  filterApplied: string | null;
  width: number | null;
  height: number | null;
  orderIndex: number;
}

export interface FeedPost {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  profilePictureUrl: string | null;
  caption: string;
  location: string | null;
  likeCount: number;
  commentCount: number;
  createdAt: Date;
  isLiked: boolean;
  isSaved: boolean;
  media: FeedMedia[];
}

export interface FeedPage {
  posts: FeedPost[];
  nextCursor: string | null;
  /** True when the precomputed timeline had to be rebuilt from PostgreSQL for this request. */
  timelineRebuilt: boolean;
  pushedCount: number;
  pulledCount: number;
  degraded?: boolean;
}

export interface FanoutResult {
  mode: 'push' | 'pull';
  followerCount: number;
  timelinesWritten: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cursor format: `<created_ms>_<post uuid>` - opaque to clients, URL-safe. */
export const encodeFeedCursor = (entry: TimelineEntry): string => `${entry.score}_${entry.postId}`;

export const decodeFeedCursor = (raw: string): FeedCursor | null => {
  const separator = raw.indexOf('_');
  if (separator <= 0) return null;
  const ts = Number(raw.slice(0, separator));
  const id = raw.slice(separator + 1).toLowerCase();
  if (!Number.isSafeInteger(ts) || ts < 0 || !UUID_RE.test(id)) return null;
  return { ts, id };
};

/** Merges two candidate lists into (score DESC, id DESC) order, dropping duplicate post ids. */
export const mergeCandidates = (a: TimelineEntry[], b: TimelineEntry[]): TimelineEntry[] => {
  const seen = new Set<string>();
  return [...a, ...b]
    .sort((x, y) => y.score - x.score || (x.postId < y.postId ? 1 : x.postId > y.postId ? -1 : 0))
    .filter((entry) => {
      if (seen.has(entry.postId)) return false;
      seen.add(entry.postId);
      return true;
    });
};

const CREATED_MS = 'FLOOR(EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint';

interface CandidateRow {
  id: string;
  created_ms: string;
}

const toEntries = (rows: CandidateRow[]): TimelineEntry[] =>
  rows.map((row) => ({ postId: row.id, score: Number(row.created_ms) }));

/**
 * Published posts strictly after `cursor`, newest first.
 * - 'regular': the viewer's own posts plus followed authors below the celebrity threshold
 *   (exactly what fan-out would have pushed; used to rebuild and to continue past the cap).
 * - 'celebrity': followed authors at or above the threshold (never pushed; merged at read time).
 */
async function selectFeedCandidates(
  viewerId: string,
  cursor: FeedCursor | null,
  limit: number,
  kind: 'regular' | 'celebrity'
): Promise<TimelineEntry[]> {
  const params: unknown[] = [viewerId, config.feed.celebrityFollowerThreshold];
  let cursorClause = '';
  if (cursor) {
    params.push(cursor.ts, cursor.id);
    cursorClause = `AND (${CREATED_MS}, p.id) < ($3::bigint, $4::uuid)`;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;

  const authorClause =
    kind === 'celebrity'
      ? `p.user_id IN (
           SELECT f.following_id FROM follows f JOIN users fu ON fu.id = f.following_id
           WHERE f.follower_id = $1 AND fu.follower_count >= $2)`
      : `(p.user_id = $1 OR p.user_id IN (
           SELECT f.following_id FROM follows f JOIN users fu ON fu.id = f.following_id
           WHERE f.follower_id = $1 AND fu.follower_count < $2))`;

  const result = await query<CandidateRow>(
    `SELECT p.id, ${CREATED_MS} AS created_ms
     FROM posts p
     WHERE p.status = 'published'
       AND ${authorClause}
       ${cursorClause}
     ORDER BY created_ms DESC, p.id DESC
     LIMIT ${limitParam}`,
    params
  );
  return toEntries(result.rows);
}

/**
 * Rebuilds a missing timeline from PostgreSQL. The built marker goes in first so that a
 * concurrent fan-out lands in the key instead of being skipped (see markTimelineBuilt).
 */
export async function rebuildTimeline(viewerId: string): Promise<number> {
  await markTimelineBuilt(viewerId);
  try {
    const entries = await selectFeedCandidates(viewerId, null, config.feed.timelineMaxEntries, 'regular');
    await mergeIntoTimeline(viewerId, entries);
    return entries.length;
  } catch (error) {
    await unmarkTimelineBuilt(viewerId).catch(() => undefined);
    throw error;
  }
}

interface HydratedRow {
  id: string;
  user_id: string;
  caption: string;
  location: string | null;
  like_count: number;
  comment_count: number;
  created_at: Date;
  username: string;
  display_name: string;
  profile_picture_url: string | null;
  is_liked: boolean;
  is_saved: boolean;
  media: FeedMedia[] | null;
}

/**
 * Loads display data for a page of post ids in ONE query: author, media (as a JSON array),
 * and the viewer's like/save state. Unpublished or deleted posts drop out here, so a stale
 * timeline entry can never render. Output keeps the order of `postIds`.
 */
export async function hydratePosts(viewerId: string | null, postIds: string[]): Promise<FeedPost[]> {
  if (postIds.length === 0) return [];
  const result = await query<HydratedRow>(
    `SELECT p.id, p.user_id, p.caption, p.location, p.like_count, p.comment_count, p.created_at,
            u.username, u.display_name, u.profile_picture_url,
            EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $2::uuid) AS is_liked,
            EXISTS (SELECT 1 FROM saved_posts s WHERE s.post_id = p.id AND s.user_id = $2::uuid) AS is_saved,
            (SELECT json_agg(json_build_object(
                      'id', m.id, 'mediaType', m.media_type, 'mediaUrl', m.media_url,
                      'thumbnailUrl', m.thumbnail_url, 'filterApplied', m.filter_applied,
                      'width', m.width, 'height', m.height, 'orderIndex', m.order_index)
                    ORDER BY m.order_index)
               FROM post_media m WHERE m.post_id = p.id) AS media
     FROM posts p
     JOIN users u ON u.id = p.user_id
     WHERE p.id = ANY($1::uuid[]) AND p.status = 'published'`,
    [postIds, viewerId]
  );

  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const posts: FeedPost[] = [];
  for (const id of postIds) {
    const row = byId.get(id);
    if (!row) continue;
    posts.push({
      id: row.id,
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      profilePictureUrl: row.profile_picture_url,
      caption: row.caption,
      location: row.location,
      likeCount: row.like_count,
      commentCount: row.comment_count,
      createdAt: row.created_at,
      isLiked: row.is_liked,
      isSaved: row.is_saved,
      media: row.media || [],
    });
  }
  return posts;
}

/** One page of the home feed (see the module comment for the algorithm). */
export async function getFeedPage(viewerId: string, cursor: FeedCursor | null, limit: number): Promise<FeedPage> {
  const fetchCount = limit + 1; // one extra row from each source tells us whether another page exists

  const [firstRead, pulled] = await Promise.all([
    readTimeline(viewerId, cursor, fetchCount),
    selectFeedCandidates(viewerId, cursor, fetchCount, 'celebrity'),
  ]);
  let timeline = firstRead;
  let timelineRebuilt = false;
  if (!timeline.built) {
    await rebuildTimeline(viewerId);
    timeline = await readTimeline(viewerId, cursor, fetchCount);
    timelineRebuilt = true;
  }

  let pushed = timeline.entries;
  if (pushed.length < fetchCount && timeline.size >= config.feed.timelineMaxEntries) {
    // The reader scrolled past the capped timeline: continue from the source of truth.
    const last = pushed[pushed.length - 1];
    const continueFrom = last ? { ts: last.score, id: last.postId } : cursor;
    const older = await selectFeedCandidates(viewerId, continueFrom, fetchCount - pushed.length, 'regular');
    pushed = pushed.concat(older);
  }

  const merged = mergeCandidates(pushed, pulled);
  const page = merged.slice(0, limit);
  const posts = await hydratePosts(viewerId, page.map((entry) => entry.postId));
  touchTimeline(viewerId).catch(() => undefined);

  const pulledIds = new Set(pulled.map((entry) => entry.postId));
  const pulledCount = page.filter((entry) => pulledIds.has(entry.postId)).length;
  return {
    posts,
    nextCursor: merged.length > limit && page.length > 0 ? encodeFeedCursor(page[page.length - 1]) : null,
    timelineRebuilt,
    pushedCount: page.length - pulledCount,
    pulledCount,
  };
}

/**
 * Calls `fn` with an author's followers in batches, paging by follower_id (keyset) so the
 * cost per batch stays constant no matter how deep into a large follower list we are.
 */
export async function forEachFollowerBatch(
  authorId: string,
  batchSize: number,
  fn: (followerIds: string[]) => Promise<void>
): Promise<number> {
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const result: { rows: { follower_id: string }[] } = after
      ? await query<{ follower_id: string }>(
          `SELECT follower_id FROM follows WHERE following_id = $1 AND follower_id > $2
           ORDER BY follower_id LIMIT $3`,
          [authorId, after, batchSize]
        )
      : await query<{ follower_id: string }>(
          `SELECT follower_id FROM follows WHERE following_id = $1 ORDER BY follower_id LIMIT $2`,
          [authorId, batchSize]
        );
    if (result.rows.length === 0) break;
    const ids = result.rows.map((row) => row.follower_id);
    total += ids.length;
    await fn(ids);
    if (ids.length < batchSize) break;
    after = ids[ids.length - 1];
  }
  return total;
}

const getFollowerCount = async (userId: string): Promise<number> => {
  const result = await query<{ follower_count: number }>('SELECT follower_count FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.follower_count ?? 0;
};

export const isCelebrity = (followerCount: number): boolean =>
  followerCount >= config.feed.celebrityFollowerThreshold;

/**
 * Write-side fan-out for a newly published post. The author's own timeline always gets the post;
 * followers' timelines only when the author is below the celebrity threshold.
 */
export async function fanOutPost(authorId: string, postId: string, createdMs: number): Promise<FanoutResult> {
  const entry: TimelineEntry = { postId, score: createdMs };
  let timelinesWritten = await addToCachedTimelines([authorId], entry);

  const followerCount = await getFollowerCount(authorId);
  if (isCelebrity(followerCount)) {
    feedFanoutTotal.labels('pull').inc();
    logger.info({ type: 'fanout_skipped', authorId, postId, followerCount }, 'Celebrity post: followers pull at read time');
    return { mode: 'pull', followerCount, timelinesWritten };
  }

  await forEachFollowerBatch(authorId, config.feed.fanoutBatchSize, async (followerIds) => {
    timelinesWritten += await addToCachedTimelines(followerIds, entry);
  });

  feedFanoutTotal.labels('push').inc();
  feedFanoutTimelineWrites.inc(timelinesWritten);
  return { mode: 'push', followerCount, timelinesWritten };
}

/** Removes a deleted post from every timeline it may have been pushed to. */
export async function removePostFromTimelines(authorId: string, postId: string): Promise<void> {
  await removeFromTimelines([authorId], [postId]);
  if (isCelebrity(await getFollowerCount(authorId))) return; // never pushed; hydration hides it anyway
  await forEachFollowerBatch(authorId, config.feed.fanoutBatchSize, (followerIds) =>
    removeFromTimelines(followerIds, [postId])
  );
}

/** After a follow: copy the author's recent posts into the viewer's timeline if it is cached. */
export async function backfillAfterFollow(viewerId: string, authorId: string): Promise<number> {
  if (isCelebrity(await getFollowerCount(authorId))) return 0; // pulled at read time
  const recent = await query<CandidateRow>(
    `SELECT p.id, ${CREATED_MS} AS created_ms FROM posts p
     WHERE p.user_id = $1 AND p.status = 'published'
     ORDER BY p.created_at DESC LIMIT $2`,
    [authorId, config.feed.followBackfillCount]
  );
  if (!(await isTimelineBuilt(viewerId))) return 0; // the next read rebuilds it, follow included
  const entries = toEntries(recent.rows);
  await mergeIntoTimeline(viewerId, entries);
  return entries.length;
}

/** After an unfollow: drop that author's posts from the viewer's timeline. */
export async function removeAuthorFromTimeline(viewerId: string, authorId: string): Promise<void> {
  const recent = await query<{ id: string }>(
    'SELECT id FROM posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [authorId, config.feed.timelineMaxEntries]
  );
  await removeFromTimelines(
    [viewerId],
    recent.rows.map((row) => row.id)
  );
}
