import { Router } from 'express';
import { query } from '../services/db.js';
import { timelineGet, cacheGet, cacheSet } from '../services/redis.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { feedRateLimiter } from '../services/rateLimiter.js';
import { createCircuitBreaker, fallbackWithDefault } from '../services/circuitBreaker.js';
import logger from '../services/logger.js';
import {
  feedGenerationDuration,
  feedCacheHits,
  feedCacheMisses,
} from '../services/metrics.js';

const router = Router();

/**
 * Circuit breaker for feed generation
 *
 * WHY CIRCUIT BREAKER FOR FEED GENERATION:
 *
 * Feed generation involves:
 * - Fetching followed users' posts from database
 * - Joining with user data and media
 * - Checking like/save status for each post
 *
 * This can be expensive and slow when:
 * - Database is under heavy load
 * - User follows many accounts
 * - Network issues between API and database
 *
 * The circuit breaker:
 * - Returns cached/empty feed when database is struggling
 * - Prevents request pile-up that could crash the service
 * - Automatically recovers when database load decreases
 */
const feedGenerationBreaker = createCircuitBreaker(
  'feed_generation',
  async (userId, offset, limit) => {
    // Get post IDs from Redis timeline cache
    const postIds = await timelineGet(userId, offset, parseInt(limit));

    if (postIds.length === 0) {
      // If no cached timeline, generate from database
      let queryText = `
        SELECT p.*, u.username, u.display_name, u.profile_picture_url
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE p.user_id IN (
          SELECT following_id FROM follows WHERE follower_id = $1
          UNION
          SELECT $1
        )
      `;
      const params = [userId];

      queryText += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1}`;
      params.push(parseInt(limit) + 1);

      const result = await query(queryText, params);

      const hasMore = result.rows.length > limit;
      const posts = result.rows.slice(0, limit);

      // Get media for each post
      const postsWithMedia = await Promise.all(
        posts.map(async (post) => {
          const mediaResult = await query(
            'SELECT * FROM post_media WHERE post_id = $1 ORDER BY order_index',
            [post.id]
          );

          // Check if current user liked/saved
          const likeCheck = await query(
            'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2',
            [userId, post.id]
          );
          const savedCheck = await query(
            'SELECT 1 FROM saved_posts WHERE user_id = $1 AND post_id = $2',
            [userId, post.id]
          );

          return {
            id: post.id,
            userId: post.user_id,
            username: post.username,
            displayName: post.display_name,
            profilePictureUrl: post.profile_picture_url,
            caption: post.caption,
            location: post.location,
            likeCount: post.like_count,
            commentCount: post.comment_count,
            createdAt: post.created_at,
            isLiked: likeCheck.rows.length > 0,
            isSaved: savedCheck.rows.length > 0,
            media: mediaResult.rows.map((m) => ({
              id: m.id,
              mediaType: m.media_type,
              mediaUrl: m.media_url,
              thumbnailUrl: m.thumbnail_url,
              filterApplied: m.filter_applied,
              width: m.width,
              height: m.height,
              orderIndex: m.order_index,
            })),
          };
        })
      );

      return { posts: postsWithMedia, hasMore, offset, limit, cacheHit: false };
    }

    // Fetch posts from database using cached IDs
    const postResult = await query(
      `SELECT p.*, u.username, u.display_name, u.profile_picture_url
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = ANY($1)`,
      [postIds]
    );

    // Order by the timeline order
    const postsMap = new Map(postResult.rows.map((p) => [p.id, p]));
    const orderedPosts = postIds.map((id) => postsMap.get(id)).filter(Boolean);

    // Get media and user-specific data for each post
    const postsWithMedia = await Promise.all(
      orderedPosts.map(async (post) => {
        const mediaResult = await query(
          'SELECT * FROM post_media WHERE post_id = $1 ORDER BY order_index',
          [post.id]
        );

        const likeCheck = await query(
          'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2',
          [userId, post.id]
        );
        const savedCheck = await query(
          'SELECT 1 FROM saved_posts WHERE user_id = $1 AND post_id = $2',
          [userId, post.id]
        );

        return {
          id: post.id,
          userId: post.user_id,
          username: post.username,
          displayName: post.display_name,
          profilePictureUrl: post.profile_picture_url,
          caption: post.caption,
          location: post.location,
          likeCount: post.like_count,
          commentCount: post.comment_count,
          createdAt: post.created_at,
          isLiked: likeCheck.rows.length > 0,
          isSaved: savedCheck.rows.length > 0,
          media: mediaResult.rows.map((m) => ({
            id: m.id,
            mediaType: m.media_type,
            mediaUrl: m.media_url,
            thumbnailUrl: m.thumbnail_url,
            filterApplied: m.filter_applied,
            width: m.width,
            height: m.height,
            orderIndex: m.order_index,
          })),
        };
      })
    );

    return {
      posts: postsWithMedia,
      hasMore: postIds.length === limit,
      offset,
      limit,
      cacheHit: true,
    };
  },
  {
    timeout: 15000, // 15 seconds timeout
    errorThresholdPercentage: 50,
    resetTimeout: 30000, // 30 seconds before testing recovery
    volumeThreshold: 5,
  }
);

// Fallback returns empty feed when circuit is open
feedGenerationBreaker.fallback(
  fallbackWithDefault({ posts: [], hasMore: false, offset: 0, limit: 20, cacheHit: false, fallback: true })
);

/**
 * Get home feed
 *
 * WHY FEED CACHING REDUCES DATABASE LOAD:
 *
 * Without caching:
 * - Each feed request queries: posts, users, follows, media, likes, saves
 * - With 10K DAU making 10 feed requests/day = 100K complex queries/day
 * - Each query can involve 5-6 JOIN operations
 *
 * With caching:
 * - Timeline stored in Redis sorted sets (fast O(log N) access)
 * - Feed data cached per user with 60s TTL
 * - Cache hit rate typically 80-90% during active browsing
 * - Database only queried on cache miss or new content
 *
 * This caching strategy:
 * - Reduces database CPU by 80%+
 * - Provides consistent <50ms feed load times
 * - Allows database to focus on write operations
 */
router.get('/', requireAuth, feedRateLimiter, async (req, res) => {
  const startTime = Date.now();

  try {
    const userId = req.session.userId;
    const { cursor, limit = 20 } = req.query;
    const offset = cursor ? parseInt(cursor) : 0;

    // Check feed cache first
    const cacheKey = `feed:${userId}:${offset}:${limit}`;
    const cached = await cacheGet(cacheKey);

    if (cached) {
      feedCacheHits.inc();
      feedGenerationDuration.labels('hit').observe((Date.now() - startTime) / 1000);

      logger.debug({
        type: 'feed_cache_hit',
        userId,
        offset,
        limit,
        durationMs: Date.now() - startTime,
      }, 'Feed cache hit');

      return res.json({
        posts: cached.posts,
        nextCursor: cached.hasMore ? offset + parseInt(limit) : null,
      });
    }

    feedCacheMisses.inc();

    // Use circuit breaker for feed generation
    const result = await feedGenerationBreaker.fire(userId, offset, parseInt(limit));

    // Track metrics
    feedGenerationDuration.labels('miss').observe((Date.now() - startTime) / 1000);

    // Log feed generation
    logger.info({
      type: 'feed_generated',
      userId,
      offset,
      limit,
      postCount: result.posts.length,
      cacheHit: result.cacheHit,
      fallback: result.fallback || false,
      durationMs: Date.now() - startTime,
    }, `Feed generated: ${result.posts.length} posts in ${Date.now() - startTime}ms`);

    // Cache the result for 60 seconds (unless it's a fallback response)
    if (!result.fallback) {
      await cacheSet(cacheKey, result, 60);
    }

    res.json({
      posts: result.posts,
      nextCursor: result.hasMore ? offset + parseInt(limit) : null,
    });
  } catch (error) {
    logger.error({
      type: 'feed_error',
      error: error.message,
      userId: req.session.userId,
      durationMs: Date.now() - startTime,
    }, `Get feed error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Explore page - discover new content
router.get('/explore', optionalAuth, async (req, res) => {
  try {
    const userId = req.session?.userId;
    const { cursor, limit = 24 } = req.query;

    // Get popular posts (not from followed users)
    let queryText = `
      SELECT p.id, p.like_count, p.comment_count, p.created_at,
             (SELECT media_url FROM post_media WHERE post_id = p.id ORDER BY order_index LIMIT 1) as thumbnail,
             (SELECT COUNT(*) FROM post_media WHERE post_id = p.id) as media_count
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE u.is_private = false
    `;
    const params = [];

    // Exclude posts from users we already follow
    if (userId) {
      params.push(userId);
      queryText += ` AND p.user_id NOT IN (
        SELECT following_id FROM follows WHERE follower_id = $${params.length}
      ) AND p.user_id != $${params.length}`;
    }

    if (cursor) {
      params.push(cursor);
      queryText += ` AND p.created_at < $${params.length}`;
    }

    // Order by engagement score (simple: likes + comments) and recency
    queryText += ` ORDER BY (p.like_count + p.comment_count * 2) DESC, p.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) + 1);

    const result = await query(queryText, params);

    const hasMore = result.rows.length > limit;
    const posts = result.rows.slice(0, limit);

    res.json({
      posts: posts.map((p) => ({
        id: p.id,
        thumbnail: p.thumbnail,
        likeCount: p.like_count,
        commentCount: p.comment_count,
        mediaCount: parseInt(p.media_count),
        createdAt: p.created_at,
      })),
      nextCursor: hasMore ? posts[posts.length - 1].created_at : null,
    });
  } catch (error) {
    logger.error({
      type: 'explore_error',
      error: error.message,
    }, `Get explore error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
