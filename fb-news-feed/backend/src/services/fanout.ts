/**
 * @fileoverview Fan-out service for distributing posts to followers' feeds.
 * Implements a hybrid push/pull strategy to optimize for different user types:
 * - Regular users (< 10K followers): Push model for low-latency feed updates
 * - Celebrities (>= 10K followers): Pull model to avoid write amplification
 * Includes comprehensive metrics for monitoring fanout operations.
 */

import { pool, redis } from '../db/connection.js';
import {
  componentLoggers,
  fanoutOperationsTotal,
  fanoutFollowersCount,
  fanoutDuration,
} from '../shared/index.js';

const log = componentLoggers.fanout;

/**
 * Threshold for classifying users as celebrities.
 * Users with this many or more followers use pull-based feed distribution.
 */
const CELEBRITY_THRESHOLD = 10000;

/**
 * Maximum number of posts to keep in a user's cached feed.
 * Older posts are trimmed to maintain reasonable memory usage.
 */
const FEED_SIZE_LIMIT = 1000;

/**
 * Result of a fan-out operation.
 */
export interface FanoutResult {
  /** Whether the operation completed successfully */
  success: boolean;
  /** Number of followers who received the post in their feed */
  followersNotified: number;
}

/**
 * Distributes a new post to all followers' feeds using hybrid push/pull strategy.
 * For regular users, the post is immediately written to all followers' feeds.
 * For celebrities, the post is stored in a Redis sorted set for pull at read time.
 *
 * @param postId - The unique identifier of the post to distribute
 * @param authorId - The user ID of the post author
 * @param createdAt - Timestamp when the post was created (used for scoring)
 * @returns Promise resolving to FanoutResult with success status and notification count
 */
export async function fanoutPost(
  postId: string,
  authorId: string,
  createdAt: Date
): Promise<FanoutResult> {
  const startTime = Date.now();

  try {
    // Check if author is a celebrity
    const authorResult = await pool.query(
      'SELECT is_celebrity, follower_count FROM users WHERE id = $1',
      [authorId]
    );

    if (authorResult.rows.length === 0) {
      return { success: false, followersNotified: 0 };
    }

    const author = authorResult.rows[0];
    const isCelebrity = author.is_celebrity || author.follower_count >= CELEBRITY_THRESHOLD;

    if (isCelebrity) {
      // Celebrity: Don't fan out, store in celebrity posts for pull at read time
      await redis.zadd(
        `celebrity_posts:${authorId}`,
        createdAt.getTime(),
        postId
      );
      // Keep only recent 100 posts for celebrities
      await redis.zremrangebyrank(`celebrity_posts:${authorId}`, 0, -101);

      // Record metrics
      const duration = (Date.now() - startTime) / 1000;
      fanoutOperationsTotal.labels('celebrity').inc();
      fanoutFollowersCount.observe(0);
      fanoutDuration.observe(duration);

      log.info(
        { postId, authorId, authorType: 'celebrity', duration_ms: Date.now() - startTime },
        'Fanout complete (celebrity - stored in cache)'
      );

      return { success: true, followersNotified: 0 };
    }

    // Regular user: Fan out to all followers
    const followersResult = await pool.query(
      `SELECT follower_id FROM friendships
       WHERE following_id = $1 AND status = 'active'`,
      [authorId]
    );

    const followers = followersResult.rows;
    const score = createdAt.getTime();

    // Batch insert into feed_items table
    if (followers.length > 0) {
      const values = followers
        .map(
          (f: { follower_id: string }, i: number) =>
            `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`
        )
        .join(', ');

      const params = followers.flatMap((f: { follower_id: string }) => [
        f.follower_id,
        postId,
        score,
        createdAt,
      ]);

      await pool.query(
        `INSERT INTO feed_items (user_id, post_id, score, created_at)
         VALUES ${values}
         ON CONFLICT (user_id, post_id) DO NOTHING`,
        params
      );

      // Also update Redis cache for active users
      const pipeline = redis.pipeline();
      for (const follower of followers) {
        const key = `feed:${follower.follower_id}`;
        pipeline.zadd(key, score, postId);
        pipeline.zremrangebyrank(key, 0, -FEED_SIZE_LIMIT - 1);
        pipeline.expire(key, 24 * 60 * 60); // 24 hour TTL
      }
      await pipeline.exec();
    }

    // Also add to author's own feed
    await pool.query(
      `INSERT INTO feed_items (user_id, post_id, score, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, post_id) DO NOTHING`,
      [authorId, postId, score, createdAt]
    );

    // Record metrics
    const duration = (Date.now() - startTime) / 1000;
    fanoutOperationsTotal.labels('regular').inc();
    fanoutFollowersCount.observe(followers.length);
    fanoutDuration.observe(duration);

    log.info(
      {
        postId,
        authorId,
        authorType: 'regular',
        followersNotified: followers.length,
        duration_ms: Date.now() - startTime,
      },
      'Fanout complete'
    );

    return { success: true, followersNotified: followers.length };
  } catch (error) {
    log.error({ error, postId, authorId }, 'Fanout error');
    return { success: false, followersNotified: 0 };
  }
}

/**
 * Removes a deleted post from all followers' feeds.
 * Cleans up both the PostgreSQL feed_items table and Redis cache entries.
 * Also removes from celebrity_posts if the author was a celebrity.
 *
 * @param postId - The unique identifier of the post to remove
 * @param authorId - The user ID of the post author (for finding followers)
 * @returns Promise that resolves when cleanup is complete
 */
export async function removeFanout(postId: string, authorId: string): Promise<void> {
  try {
    // Remove from database feed items
    await pool.query('DELETE FROM feed_items WHERE post_id = $1', [postId]);

    // Remove from Redis caches
    const followersResult = await pool.query(
      `SELECT follower_id FROM friendships
       WHERE following_id = $1 AND status = 'active'`,
      [authorId]
    );

    if (followersResult.rows.length > 0) {
      const pipeline = redis.pipeline();
      for (const follower of followersResult.rows) {
        pipeline.zrem(`feed:${follower.follower_id}`, postId);
      }
      await pipeline.exec();
    }

    // Remove from celebrity posts if applicable
    await redis.zrem(`celebrity_posts:${authorId}`, postId);

    log.info({ postId, authorId }, 'Fanout removed');
  } catch (error) {
    log.error({ error, postId, authorId }, 'Remove fanout error');
  }
}

/**
 * Updates the affinity score between two users based on their interactions.
 * Affinity scores influence feed ranking, surfacing content from users
 * you interact with frequently. Different interaction types have different weights.
 *
 * @param userId - The user performing the interaction
 * @param targetUserId - The user whose content was interacted with
 * @param interactionType - Type of interaction (like, comment, share, or view)
 * @returns Promise that resolves when the score is updated
 */
export async function updateAffinity(
  userId: string,
  targetUserId: string,
  interactionType: 'like' | 'comment' | 'share' | 'view'
): Promise<void> {
  const weights: Record<string, number> = {
    like: 2,
    comment: 5,
    share: 10,
    view: 0.5,
  };

  const scoreIncrease = weights[interactionType] || 1;

  try {
    await pool.query(
      `INSERT INTO affinity_scores (user_id, target_user_id, score, last_interaction_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, target_user_id)
       DO UPDATE SET
         score = affinity_scores.score + $3,
         last_interaction_at = NOW(),
         updated_at = NOW()`,
      [userId, targetUserId, scoreIncrease]
    );

    // Cache in Redis
    await redis.zincrby(`affinity:${userId}`, scoreIncrease, targetUserId);

    log.debug(
      { userId, targetUserId, interactionType, scoreIncrease },
      'Affinity updated'
    );
  } catch (error) {
    log.error({ error, userId, targetUserId, interactionType }, 'Update affinity error');
  }
}

/**
 * Calculates a ranking score for a post based on engagement, recency, and affinity.
 * The formula balances multiple factors:
 * - Engagement: likes, comments (3x), shares (5x) weighted by importance
 * - Recency decay: exponential decay with ~12 hour half-life
 * - Affinity boost: up to 2x boost for content from close connections
 *
 * @param post - Post data with engagement metrics and creation timestamp
 * @param affinityScore - Optional affinity score between viewer and author (0-100+)
 * @returns Numeric score for ranking posts in the feed (higher is better)
 */
export function calculatePostScore(
  post: {
    created_at: Date;
    like_count: number;
    comment_count: number;
    share_count: number;
  },
  affinityScore: number = 0
): number {
  const now = Date.now();
  const postAge = (now - new Date(post.created_at).getTime()) / (1000 * 60 * 60); // hours

  // Base engagement score
  const engagementScore =
    post.like_count * 1 + post.comment_count * 3 + post.share_count * 5;

  // Recency decay (half-life of ~12 hours)
  const recencyDecay = 1 / (1 + postAge * 0.08);

  // Affinity boost
  const affinityBoost = 1 + Math.min(affinityScore, 100) / 100;

  // Final score
  return engagementScore * recencyDecay * affinityBoost * 1000;
}
