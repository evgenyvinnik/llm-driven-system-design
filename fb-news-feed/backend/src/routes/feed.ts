/**
 * @fileoverview Feed generation routes for personalized and explore feeds.
 * Implements the hybrid push/pull model by merging pre-computed feed items
 * with celebrity posts fetched at read time. Applies ranking and diversity.
 * Includes Redis caching, circuit breaker protection, and comprehensive metrics.
 */

import { Router, Request, Response } from 'express';
import { pool, redis } from '../db/connection.js';
import { authMiddleware } from '../middleware/auth.js';
import { calculatePostScore } from '../services/fanout.js';
import {
  componentLoggers,
  feedGenerationDuration,
  feedRequestsTotal,
  feedPostsCount,
  getFeedFromCache,
  setFeedCache,
  cacheOperationsTotal,
  createCircuitBreaker,
  BREAKER_PRESETS,
} from '../shared/index.js';

const log = componentLoggers.feed;

/** Express router for feed endpoints */
const router = Router();

/**
 * Threshold for classifying users as celebrities (pull-based feed).
 * Must match the threshold in fanout.ts for consistent behavior.
 */
const CELEBRITY_THRESHOLD = 10000;

/**
 * Interface for feed generation parameters.
 */
interface FeedGenerationParams {
  userId: string;
  limit: number;
  cursor?: string;
}

/**
 * Interface for feed generation result.
 */
interface FeedGenerationResult {
  posts: unknown[];
  cursor: string | null;
  has_more: boolean;
  cacheHit: boolean;
}

/**
 * Core feed generation logic wrapped for circuit breaker protection.
 * Combines pre-computed feed items with celebrity posts, applies ranking.
 *
 * @param params - Feed generation parameters
 * @returns Promise with feed posts, cursor, and cache hit status
 */
async function generateFeed(params: FeedGenerationParams): Promise<FeedGenerationResult> {
  const { userId, limit, cursor } = params;
  let cacheHit = false;

  // Step 1: Try to get feed from cache first
  const cachedFeed = await getFeedFromCache(
    userId,
    limit * 3,
    cursor ? parseFloat(cursor) : undefined
  );

  let feedPostIds: string[] = [];

  if (cachedFeed && cachedFeed.length > 0) {
    cacheHit = true;
    feedPostIds = cachedFeed;
    log.debug({ userId, count: cachedFeed.length }, 'Feed loaded from cache');
  } else {
    // Step 1b: Get pre-computed feed items from database
    let feedQuery = `
      SELECT fi.post_id, fi.score, fi.created_at as feed_created_at
      FROM feed_items fi
      WHERE fi.user_id = $1
    `;

    const feedParams: (string | number)[] = [userId];
    let paramIndex = 2;

    if (cursor) {
      feedQuery += ` AND fi.created_at < $${paramIndex++}`;
      feedParams.push(cursor);
    }

    feedQuery += ` ORDER BY fi.created_at DESC LIMIT $${paramIndex}`;
    feedParams.push(limit * 3); // Fetch more to allow for filtering and ranking

    const feedItemsResult = await pool.query(feedQuery, feedParams);
    feedPostIds = feedItemsResult.rows.map((r: { post_id: string }) => r.post_id);

    // Cache the feed items for future requests
    if (feedItemsResult.rows.length > 0) {
      const cacheItems = feedItemsResult.rows.map((r: { post_id: string; score: number }) => ({
        postId: r.post_id,
        score: r.score,
      }));
      await setFeedCache(userId, cacheItems);
    }
  }

  // Step 2: Get celebrity posts (for users we follow who are celebrities)
  const celebrityPostIds: string[] = [];

  // Get celebrities the user follows
  const celebritiesResult = await pool.query(
    `SELECT u.id FROM users u
     JOIN friendships f ON f.following_id = u.id
     WHERE f.follower_id = $1 AND f.status = 'active'
     AND (u.is_celebrity = true OR u.follower_count >= $2)`,
    [userId, CELEBRITY_THRESHOLD]
  );

  for (const celeb of celebritiesResult.rows) {
    // Try Redis cache first
    const cachedPosts = await redis.zrevrange(
      `celebrity_posts:${celeb.id}`,
      0,
      9
    );

    if (cachedPosts.length > 0) {
      cacheOperationsTotal.labels('celebrity_posts', 'hit').inc();
      celebrityPostIds.push(...cachedPosts);
    } else {
      cacheOperationsTotal.labels('celebrity_posts', 'miss').inc();
      // Fallback to database
      const celebPostsResult = await pool.query(
        `SELECT id FROM posts
         WHERE author_id = $1 AND is_deleted = false
         ORDER BY created_at DESC
         LIMIT 10`,
        [celeb.id]
      );
      celebrityPostIds.push(...celebPostsResult.rows.map((r: { id: string }) => r.id));
    }
  }

  // Step 3: Merge and deduplicate post IDs
  const allPostIds = [...new Set([...feedPostIds, ...celebrityPostIds])];

  if (allPostIds.length === 0) {
    // No feed items, return empty or popular posts
    const popularResult = await pool.query(
      `SELECT p.*, u.id as author_id, u.username as author_username,
              u.display_name as author_display_name, u.avatar_url as author_avatar_url,
              u.is_celebrity as author_is_celebrity
       FROM posts p
       JOIN users u ON p.author_id = u.id
       WHERE p.is_deleted = false AND p.privacy = 'public'
       ORDER BY p.like_count DESC, p.created_at DESC
       LIMIT $1`,
      [limit]
    );

    const posts = popularResult.rows.map((p: {
      id: string;
      content: string;
      image_url: string | null;
      post_type: string;
      privacy: string;
      like_count: number;
      comment_count: number;
      share_count: number;
      created_at: Date;
      updated_at: Date;
      author_id: string;
      author_username: string;
      author_display_name: string;
      author_avatar_url: string | null;
      author_is_celebrity: boolean;
    }) => ({
      id: p.id,
      content: p.content,
      image_url: p.image_url,
      post_type: p.post_type,
      privacy: p.privacy,
      like_count: p.like_count,
      comment_count: p.comment_count,
      share_count: p.share_count,
      created_at: p.created_at,
      updated_at: p.updated_at,
      is_liked: false,
      author: {
        id: p.author_id,
        username: p.author_username,
        display_name: p.author_display_name,
        avatar_url: p.author_avatar_url,
        is_celebrity: p.author_is_celebrity,
      },
    }));

    return { posts, cursor: null, has_more: false, cacheHit };
  }

  // Step 4: Fetch full post data
  const postsResult = await pool.query(
    `SELECT p.*, u.id as author_id, u.username as author_username,
            u.display_name as author_display_name, u.avatar_url as author_avatar_url,
            u.is_celebrity as author_is_celebrity
     FROM posts p
     JOIN users u ON p.author_id = u.id
     WHERE p.id = ANY($1) AND p.is_deleted = false`,
    [allPostIds]
  );

  // Step 5: Get affinity scores for ranking
  const authorIds = [...new Set(postsResult.rows.map((p: { author_id: string }) => p.author_id))];
  const affinityResult = await pool.query(
    `SELECT target_user_id, score FROM affinity_scores
     WHERE user_id = $1 AND target_user_id = ANY($2)`,
    [userId, authorIds]
  );

  const affinityMap = new Map<string, number>();
  for (const row of affinityResult.rows) {
    affinityMap.set(row.target_user_id, row.score);
  }

  // Step 6: Check which posts the user has liked
  const likesResult = await pool.query(
    `SELECT post_id FROM likes WHERE user_id = $1 AND post_id = ANY($2)`,
    [userId, allPostIds]
  );
  const likedPostIds = new Set(likesResult.rows.map((r: { post_id: string }) => r.post_id));

  // Step 7: Calculate scores and rank posts
  const scoredPosts = postsResult.rows.map((p: {
    id: string;
    content: string;
    image_url: string | null;
    post_type: string;
    privacy: string;
    like_count: number;
    comment_count: number;
    share_count: number;
    created_at: Date;
    updated_at: Date;
    author_id: string;
    author_username: string;
    author_display_name: string;
    author_avatar_url: string | null;
    author_is_celebrity: boolean;
  }) => {
    const affinityScore = affinityMap.get(p.author_id) || 0;
    const score = calculatePostScore(
      {
        created_at: p.created_at,
        like_count: p.like_count,
        comment_count: p.comment_count,
        share_count: p.share_count,
      },
      affinityScore
    );

    return {
      id: p.id,
      content: p.content,
      image_url: p.image_url,
      post_type: p.post_type,
      privacy: p.privacy,
      like_count: p.like_count,
      comment_count: p.comment_count,
      share_count: p.share_count,
      created_at: p.created_at,
      updated_at: p.updated_at,
      is_liked: likedPostIds.has(p.id),
      author: {
        id: p.author_id,
        username: p.author_username,
        display_name: p.author_display_name,
        avatar_url: p.author_avatar_url,
        is_celebrity: p.author_is_celebrity,
      },
      _score: score,
    };
  });

  // Sort by score (ranking)
  scoredPosts.sort((a: { _score: number }, b: { _score: number }) => b._score - a._score);

  // Apply diversity: don't show more than 3 consecutive posts from same author
  const diversifiedPosts: typeof scoredPosts = [];
  const authorCounts = new Map<string, number>();
  const MAX_CONSECUTIVE = 3;

  for (const post of scoredPosts) {
    const authorId = post.author.id;
    const count = authorCounts.get(authorId) || 0;

    if (count < MAX_CONSECUTIVE) {
      diversifiedPosts.push(post);
      authorCounts.set(authorId, count + 1);
    }

    if (diversifiedPosts.length >= limit + 1) break;
  }

  // Step 8: Prepare response
  const resultPosts = diversifiedPosts.slice(0, limit).map(({ _score, ...post }) => post);
  const hasMore = diversifiedPosts.length > limit;
  const nextCursor = hasMore && resultPosts.length > 0
    ? String(resultPosts[resultPosts.length - 1].created_at)
    : null;

  return { posts: resultPosts, cursor: nextCursor, has_more: hasMore, cacheHit };
}

/**
 * Circuit breaker for feed generation.
 * Opens when feed generation consistently fails, providing fast failure
 * instead of cascading delays through the system.
 */
const feedGenerationBreaker = createCircuitBreaker<[FeedGenerationParams], FeedGenerationResult>(
  (params: FeedGenerationParams) => generateFeed(params),
  'feed_generation',
  BREAKER_PRESETS.critical
);

/**
 * Fallback feed when circuit breaker is open.
 * Returns popular posts as a degraded experience.
 */
feedGenerationBreaker.fallback(async (): Promise<FeedGenerationResult> => {
  log.warn('Using fallback feed due to circuit breaker');

  const popularResult = await pool.query(
    `SELECT p.*, u.id as author_id, u.username as author_username,
            u.display_name as author_display_name, u.avatar_url as author_avatar_url,
            u.is_celebrity as author_is_celebrity
     FROM posts p
     JOIN users u ON p.author_id = u.id
     WHERE p.is_deleted = false AND p.privacy = 'public'
     ORDER BY p.like_count DESC, p.created_at DESC
     LIMIT 20`
  );

  const posts = popularResult.rows.map((p: {
    id: string;
    content: string;
    image_url: string | null;
    post_type: string;
    privacy: string;
    like_count: number;
    comment_count: number;
    share_count: number;
    created_at: Date;
    updated_at: Date;
    author_id: string;
    author_username: string;
    author_display_name: string;
    author_avatar_url: string | null;
    author_is_celebrity: boolean;
  }) => ({
    id: p.id,
    content: p.content,
    image_url: p.image_url,
    post_type: p.post_type,
    privacy: p.privacy,
    like_count: p.like_count,
    comment_count: p.comment_count,
    share_count: p.share_count,
    created_at: p.created_at,
    updated_at: p.updated_at,
    is_liked: false,
    author: {
      id: p.author_id,
      username: p.author_username,
      display_name: p.author_display_name,
      avatar_url: p.author_avatar_url,
      is_celebrity: p.author_is_celebrity,
    },
  }));

  return { posts, cursor: null, has_more: false, cacheHit: false };
});

/**
 * GET / - Returns the authenticated user's personalized home feed.
 * Combines pre-computed feed items (push model) with celebrity posts (pull model).
 * Ranks posts by engagement, recency, and affinity, then applies diversity rules.
 * Protected by circuit breaker for graceful degradation under load.
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const userId = req.user!.id;
    const limit = parseInt(req.query.limit as string) || 20;
    const cursor = req.query.cursor as string | undefined;

    // Record feed request
    feedRequestsTotal.labels('home').inc();

    // Use circuit breaker for feed generation
    const result = await feedGenerationBreaker.fire({ userId, limit, cursor });

    // Record metrics
    const duration = (Date.now() - startTime) / 1000;
    feedGenerationDuration.labels(result.cacheHit ? 'true' : 'false').observe(duration);
    feedPostsCount.observe(result.posts.length);

    log.info(
      {
        userId,
        postCount: result.posts.length,
        cacheHit: result.cacheHit,
        duration_ms: Date.now() - startTime,
      },
      'Feed generated'
    );

    res.json({
      posts: result.posts,
      cursor: result.cursor,
      has_more: result.has_more,
    });
  } catch (error) {
    log.error({ error }, 'Get feed error');

    // Record failed duration
    const duration = (Date.now() - startTime) / 1000;
    feedGenerationDuration.labels('false').observe(duration);

    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /explore - Returns trending public posts from the last 7 days.
 * Available to all users without authentication.
 * Ranks posts by weighted engagement score (likes + comments*2 + shares*3).
 */
router.get('/explore', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    // Record feed request
    feedRequestsTotal.labels('explore').inc();

    // Get popular public posts from the last 7 days
    const result = await pool.query(
      `SELECT p.*, u.id as author_id, u.username as author_username,
              u.display_name as author_display_name, u.avatar_url as author_avatar_url,
              u.is_celebrity as author_is_celebrity
       FROM posts p
       JOIN users u ON p.author_id = u.id
       WHERE p.is_deleted = false
         AND p.privacy = 'public'
         AND p.created_at > NOW() - INTERVAL '7 days'
       ORDER BY (p.like_count + p.comment_count * 2 + p.share_count * 3) DESC, p.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const posts = result.rows.map((p: {
      id: string;
      content: string;
      image_url: string | null;
      post_type: string;
      privacy: string;
      like_count: number;
      comment_count: number;
      share_count: number;
      created_at: Date;
      updated_at: Date;
      author_id: string;
      author_username: string;
      author_display_name: string;
      author_avatar_url: string | null;
      author_is_celebrity: boolean;
    }) => ({
      id: p.id,
      content: p.content,
      image_url: p.image_url,
      post_type: p.post_type,
      privacy: p.privacy,
      like_count: p.like_count,
      comment_count: p.comment_count,
      share_count: p.share_count,
      created_at: p.created_at,
      updated_at: p.updated_at,
      is_liked: false,
      author: {
        id: p.author_id,
        username: p.author_username,
        display_name: p.author_display_name,
        avatar_url: p.author_avatar_url,
        is_celebrity: p.author_is_celebrity,
      },
    }));

    // Record metrics
    const duration = (Date.now() - startTime) / 1000;
    feedGenerationDuration.labels('false').observe(duration);
    feedPostsCount.observe(posts.length);

    res.json({
      posts,
      has_more: result.rows.length === limit,
    });
  } catch (error) {
    log.error({ error }, 'Get explore feed error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
