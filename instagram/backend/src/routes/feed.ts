import { Router, Response } from 'express';
import { query } from '../services/db.js';
import { requireAuth, optionalAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { feedRateLimiter } from '../services/rateLimiter.js';
import { createCircuitBreaker, fallbackWithDefault } from '../services/circuitBreaker.js';
import { getFeedPage, decodeFeedCursor, FeedCursor, FeedPage } from '../services/feedService.js';
import logger from '../services/logger.js';
import { feedGenerationDuration, feedCacheHits, feedCacheMisses } from '../services/metrics.js';

const router = Router();

interface ExplorePostRow {
  id: string;
  thumbnail: string | null;
  like_count: number;
  comment_count: number;
  media_count: string;
  created_at: Date;
  score: number;
  created_ms: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses ?limit= into [1, max], falling back to the default for missing or invalid values. */
const parseLimit = (raw: unknown, fallback: number, max: number): number => {
  const parsed = parseInt(typeof raw === 'string' ? raw : '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
};

/**
 * Circuit breaker for feed generation
 *
 * A feed page is one Redis round trip, one celebrity query, and one hydration query. When
 * PostgreSQL or Redis is struggling those calls slow down together; the breaker fails fast with
 * an empty, explicitly degraded page instead of letting requests pile up behind a sick
 * dependency, and closes again once probes succeed.
 */
const feedGenerationBreaker = createCircuitBreaker(
  'feed_generation',
  (viewerId: string, cursor: FeedCursor | null, limit: number): Promise<FeedPage> =>
    getFeedPage(viewerId, cursor, limit),
  {
    timeout: 15000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 5,
  }
);

feedGenerationBreaker.fallback(
  fallbackWithDefault<FeedPage>({
    posts: [],
    nextCursor: null,
    timelineRebuilt: false,
    pushedCount: 0,
    pulledCount: 0,
    degraded: true,
  })
);

/**
 * Home feed: GET /api/v1/feed?cursor=<opaque>&limit=20
 *
 * Pages are keyed by (created_ms, post id) rather than an offset, so posts that arrive while
 * the user scrolls never shift later pages. There is deliberately no response cache: the Redis
 * timeline already makes the expensive part (which posts) cheap, and a cached page would serve
 * stale like/save state for its whole TTL.
 */
router.get('/', requireAuth, feedRateLimiter, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const startTime = Date.now();
  const userId = req.session.userId!;
  const limit = parseLimit(req.query.limit, 20, 50);

  let cursor: FeedCursor | null = null;
  if (typeof req.query.cursor === 'string' && req.query.cursor.length > 0) {
    cursor = decodeFeedCursor(req.query.cursor);
    if (!cursor) {
      res.status(400).json({ error: 'Invalid cursor' });
      return;
    }
  }

  try {
    const page = (await feedGenerationBreaker.fire(userId, cursor, limit)) as FeedPage;

    const cacheStatus = page.timelineRebuilt ? 'miss' : 'hit';
    (page.timelineRebuilt ? feedCacheMisses : feedCacheHits).inc();
    feedGenerationDuration.labels(cacheStatus).observe((Date.now() - startTime) / 1000);

    logger.info(
      {
        type: 'feed_generated',
        userId,
        limit,
        postCount: page.posts.length,
        pushed: page.pushedCount,
        pulled: page.pulledCount,
        timelineRebuilt: page.timelineRebuilt,
        degraded: page.degraded || false,
        durationMs: Date.now() - startTime,
      },
      `Feed generated: ${page.posts.length} posts in ${Date.now() - startTime}ms`
    );

    res.json({
      posts: page.posts,
      nextCursor: page.nextCursor,
      ...(page.degraded ? { degraded: true } : {}),
    });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'feed_error',
        error: err.message,
        userId,
        durationMs: Date.now() - startTime,
      },
      `Get feed error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Explore page - discover popular posts from public accounts the viewer doesn't follow.
 *
 * Ordered by (engagement score, created_ms, id). The cursor carries all three, so the next page
 * starts exactly where this one ended; a created_at-only cursor against a score ordering repeated
 * some posts and silently skipped others.
 */
router.get('/explore', optionalAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.session?.userId;
    const parsedLimit = parseLimit(req.query.limit, 24, 60);
    const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor : '';

    const params: (string | number)[] = [];
    let queryText = `
      SELECT p.id, p.like_count, p.comment_count, p.created_at,
             (p.like_count + p.comment_count * 2) AS score,
             FLOOR(EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint AS created_ms,
             (SELECT media_url FROM post_media WHERE post_id = p.id ORDER BY order_index LIMIT 1) as thumbnail,
             (SELECT COUNT(*) FROM post_media WHERE post_id = p.id) as media_count
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE u.is_private = false AND p.status = 'published'
    `;

    // Exclude posts from users we already follow, and our own
    if (userId) {
      params.push(userId);
      queryText += ` AND p.user_id NOT IN (
        SELECT following_id FROM follows WHERE follower_id = $${params.length}
      ) AND p.user_id != $${params.length}`;
    }

    if (rawCursor) {
      const [score, createdMs, id] = rawCursor.split('_');
      if (!/^\d+$/.test(score || '') || !/^\d+$/.test(createdMs || '') || !UUID_RE.test(id || '')) {
        res.status(400).json({ error: 'Invalid cursor' });
        return;
      }
      params.push(Number(score), Number(createdMs), id);
      const n = params.length;
      queryText += ` AND ((p.like_count + p.comment_count * 2), FLOOR(EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint, p.id)
                     < ($${n - 2}::int, $${n - 1}::bigint, $${n}::uuid)`;
    }

    queryText += ` ORDER BY score DESC, created_ms DESC, p.id DESC LIMIT $${params.length + 1}`;
    params.push(parsedLimit + 1);

    const result = await query<ExplorePostRow>(queryText, params);

    const hasMore = result.rows.length > parsedLimit;
    const posts = result.rows.slice(0, parsedLimit);
    const last = posts[posts.length - 1];

    res.json({
      posts: posts.map((p: ExplorePostRow) => ({
        id: p.id,
        thumbnail: p.thumbnail,
        likeCount: p.like_count,
        commentCount: p.comment_count,
        mediaCount: parseInt(p.media_count),
        createdAt: p.created_at,
      })),
      nextCursor: hasMore && last ? `${last.score}_${last.created_ms}_${last.id}` : null,
    });
  } catch (error) {
    const err = error as Error;
    logger.error({
      type: 'explore_error',
      error: err.message,
    }, `Get explore error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
