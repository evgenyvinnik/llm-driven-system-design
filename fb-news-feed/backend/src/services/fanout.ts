import { pool, redis } from '../db/connection.js';

const CELEBRITY_THRESHOLD = 10000;
const FEED_SIZE_LIMIT = 1000;

export interface FanoutResult {
  success: boolean;
  followersNotified: number;
}

/**
 * Fan-out service for distributing posts to followers' feeds
 * Implements hybrid fan-out strategy:
 * - Regular users (< 10K followers): Push model (fan-out on write)
 * - Celebrities (>= 10K followers): Pull model (fetch at read time)
 */
export async function fanoutPost(
  postId: string,
  authorId: string,
  createdAt: Date
): Promise<FanoutResult> {
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

    return { success: true, followersNotified: followers.length };
  } catch (error) {
    console.error('Fan-out error:', error);
    return { success: false, followersNotified: 0 };
  }
}

/**
 * Remove a post from all followers' feeds (when post is deleted)
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
  } catch (error) {
    console.error('Remove fan-out error:', error);
  }
}

/**
 * Update affinity score between two users based on interaction
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
  } catch (error) {
    console.error('Update affinity error:', error);
  }
}

/**
 * Calculate ranking score for a post
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
