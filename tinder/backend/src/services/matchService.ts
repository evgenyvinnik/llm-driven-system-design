import { pool, redis } from '../db/index.js';
import type { Match, MatchWithUser } from '../types/index.js';
import { retentionConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { cacheHitsTotal, cacheMissesTotal } from '../shared/metrics.js';

/**
 * Service responsible for swipe processing, match detection, and match management.
 * Handles the core matching logic: storing swipes, detecting mutual likes, and creating matches.
 * Uses Redis for fast mutual-like detection and PostgreSQL for persistence.
 *
 * Features:
 * - Idempotency support via optional idempotency keys
 * - Configurable cache TTLs from retention config
 * - Metrics for cache hit/miss tracking
 */
export class MatchService {
  /**
   * Processes a swipe action and checks for mutual match.
   * If both users have liked each other, creates a match and returns match data.
   * Caches swipes in Redis for fast subsequent lookups.
   *
   * @param swiperId - The user who is swiping
   * @param swipedId - The user being swiped on
   * @param direction - 'like' or 'pass'
   * @param idempotencyKey - Optional client-provided unique request identifier for idempotency
   * @returns Object with match data (if mutual like) and isNewMatch flag
   */
  async processSwipe(
    swiperId: string,
    swipedId: string,
    direction: 'like' | 'pass',
    idempotencyKey?: string
  ): Promise<{ match: Match | null; isNewMatch: boolean }> {
    // Record the swipe in database with optional idempotency key
    const insertQuery = idempotencyKey
      ? `INSERT INTO swipes (swiper_id, swiped_id, direction, idempotency_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (swiper_id, swiped_id) DO UPDATE SET direction = $3, idempotency_key = COALESCE(swipes.idempotency_key, $4)`
      : `INSERT INTO swipes (swiper_id, swiped_id, direction)
         VALUES ($1, $2, $3)
         ON CONFLICT (swiper_id, swiped_id) DO UPDATE SET direction = $3`;

    const insertParams = idempotencyKey
      ? [swiperId, swipedId, direction, idempotencyKey]
      : [swiperId, swipedId, direction];

    await pool.query(insertQuery, insertParams);

    // Add to Redis seen set with configurable TTL
    const redisKey = direction === 'like' ? `swipes:${swiperId}:liked` : `swipes:${swiperId}:passed`;
    await redis.sadd(redisKey, swipedId);
    await redis.expire(redisKey, retentionConfig.swipeCacheTTL);

    // If it's a like, check for mutual match
    if (direction === 'like') {
      // Add to received likes for the swiped user
      await redis.sadd(`likes:received:${swipedId}`, swiperId);
      await redis.expire(`likes:received:${swipedId}`, retentionConfig.likesReceivedTTL);

      // Check if they liked us back (Redis first for speed)
      const mutualLike = await redis.sismember(`swipes:${swipedId}:liked`, swiperId);

      if (mutualLike) {
        // Cache hit - found mutual like in Redis
        cacheHitsTotal.inc({ cache_type: 'swipe_history' });
        logger.debug({ swiperId, swipedId }, 'Mutual like found in Redis cache');

        // It's a match!
        const match = await this.createMatch(swiperId, swipedId);
        return { match, isNewMatch: true };
      }

      // Cache miss - check database as fallback
      cacheMissesTotal.inc({ cache_type: 'swipe_history' });

      const dbResult = await pool.query(
        `SELECT id FROM swipes
         WHERE swiper_id = $1 AND swiped_id = $2 AND direction = 'like'`,
        [swipedId, swiperId]
      );

      if (dbResult.rows.length > 0) {
        logger.debug({ swiperId, swipedId }, 'Mutual like found in database fallback');
        const match = await this.createMatch(swiperId, swipedId);
        return { match, isNewMatch: true };
      }
    }

    return { match: null, isNewMatch: false };
  }

  /**
   * Creates a match record between two users.
   * Uses consistent UUID ordering to prevent duplicate matches.
   * Returns existing match if one already exists.
   * @param user1Id - First user's UUID
   * @param user2Id - Second user's UUID
   * @returns The created or existing match record
   */
  private async createMatch(user1Id: string, user2Id: string): Promise<Match> {
    // Ensure consistent ordering (smaller UUID first)
    const [first, second] = user1Id < user2Id ? [user1Id, user2Id] : [user2Id, user1Id];

    // Check if match already exists
    const existingMatch = await pool.query(
      'SELECT * FROM matches WHERE user1_id = $1 AND user2_id = $2',
      [first, second]
    );

    if (existingMatch.rows.length > 0) {
      return existingMatch.rows[0];
    }

    // Create new match
    const result = await pool.query(
      `INSERT INTO matches (user1_id, user2_id)
       VALUES ($1, $2)
       RETURNING *`,
      [first, second]
    );

    return result.rows[0];
  }

  /**
   * Retrieves all matches for a user with the other user's info.
   * Includes last message preview for conversation list display.
   * Orders by most recent activity (message or match time).
   * @param userId - The user's UUID
   * @returns Array of matches with user info and message previews
   */
  async getUserMatches(userId: string): Promise<MatchWithUser[]> {
    const result = await pool.query(
      `SELECT
        m.id,
        m.matched_at,
        m.last_message_at,
        CASE WHEN m.user1_id = $1 THEN m.user2_id ELSE m.user1_id END as other_user_id
      FROM matches m
      WHERE m.user1_id = $1 OR m.user2_id = $1
      ORDER BY COALESCE(m.last_message_at, m.matched_at) DESC`,
      [userId]
    );

    // Get user details and last message for each match
    const matches: MatchWithUser[] = await Promise.all(
      result.rows.map(async (row) => {
        const [userResult, photoResult, lastMessageResult] = await Promise.all([
          pool.query(
            'SELECT id, name FROM users WHERE id = $1',
            [row.other_user_id]
          ),
          pool.query(
            'SELECT url FROM photos WHERE user_id = $1 AND is_primary = true LIMIT 1',
            [row.other_user_id]
          ),
          pool.query(
            `SELECT content FROM messages WHERE match_id = $1 ORDER BY sent_at DESC LIMIT 1`,
            [row.id]
          ),
        ]);

        return {
          id: row.id,
          matched_at: row.matched_at,
          last_message_at: row.last_message_at,
          last_message_preview: lastMessageResult.rows[0]?.content?.substring(0, 50),
          user: {
            id: userResult.rows[0].id,
            name: userResult.rows[0].name,
            primary_photo: photoResult.rows[0]?.url || null,
          },
        };
      })
    );

    return matches;
  }

  /**
   * Checks if two users have an existing match.
   * @param userId1 - First user's UUID
   * @param userId2 - Second user's UUID
   * @returns Match record if matched, null otherwise
   */
  async areMatched(userId1: string, userId2: string): Promise<Match | null> {
    const [first, second] = userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];

    const result = await pool.query(
      'SELECT * FROM matches WHERE user1_id = $1 AND user2_id = $2',
      [first, second]
    );

    return result.rows[0] || null;
  }

  /**
   * Retrieves a match by its ID.
   * @param matchId - The match's UUID
   * @returns Match record or null if not found
   */
  async getMatchById(matchId: string): Promise<Match | null> {
    const result = await pool.query(
      'SELECT * FROM matches WHERE id = $1',
      [matchId]
    );
    return result.rows[0] || null;
  }

  /**
   * Removes a match between two users.
   * Deletes the match record, associated messages (via cascade), and swipe history.
   * Cleans up Redis caches to prevent stale data.
   * @param matchId - The match's UUID
   * @param userId - The requesting user (must be part of the match)
   * @returns True if unmatched successfully, false if unauthorized
   */
  async unmatch(matchId: string, userId: string): Promise<boolean> {
    // Verify user is part of this match
    const match = await this.getMatchById(matchId);
    if (!match || (match.user1_id !== userId && match.user2_id !== userId)) {
      return false;
    }

    // Delete the match (messages will cascade)
    await pool.query('DELETE FROM matches WHERE id = $1', [matchId]);

    // Also delete swipes between the two users
    await pool.query(
      'DELETE FROM swipes WHERE (swiper_id = $1 AND swiped_id = $2) OR (swiper_id = $2 AND swiped_id = $1)',
      [match.user1_id, match.user2_id]
    );

    // Clear from Redis
    await redis.srem(`swipes:${match.user1_id}:liked`, match.user2_id);
    await redis.srem(`swipes:${match.user2_id}:liked`, match.user1_id);
    await redis.srem(`likes:received:${match.user1_id}`, match.user2_id);
    await redis.srem(`likes:received:${match.user2_id}`, match.user1_id);

    return true;
  }

  /**
   * Retrieves aggregate match and swipe statistics for admin dashboard.
   * Includes total counts, today's activity, and like rate percentage.
   * @returns Statistics object with match and swipe metrics
   */
  async getMatchStats(): Promise<{
    totalMatches: number;
    matchesToday: number;
    totalSwipes: number;
    swipesToday: number;
    likeRate: number;
  }> {
    const [matchesTotal, matchesToday, swipesTotal, swipesToday, likes] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM matches'),
      pool.query("SELECT COUNT(*) FROM matches WHERE matched_at >= NOW() - INTERVAL '1 day'"),
      pool.query('SELECT COUNT(*) FROM swipes'),
      pool.query("SELECT COUNT(*) FROM swipes WHERE created_at >= NOW() - INTERVAL '1 day'"),
      pool.query("SELECT COUNT(*) FROM swipes WHERE direction = 'like'"),
    ]);

    const totalSwipes = parseInt(swipesTotal.rows[0].count);
    const totalLikes = parseInt(likes.rows[0].count);

    return {
      totalMatches: parseInt(matchesTotal.rows[0].count),
      matchesToday: parseInt(matchesToday.rows[0].count),
      totalSwipes,
      swipesToday: parseInt(swipesToday.rows[0].count),
      likeRate: totalSwipes > 0 ? (totalLikes / totalSwipes) * 100 : 0,
    };
  }
}
