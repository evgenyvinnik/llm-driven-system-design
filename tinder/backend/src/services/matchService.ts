import { pool, redis } from '../db/index.js';
import type { Match, MatchWithUser } from '../types/index.js';

export class MatchService {
  // Process a swipe action
  async processSwipe(
    swiperId: string,
    swipedId: string,
    direction: 'like' | 'pass'
  ): Promise<{ match: Match | null; isNewMatch: boolean }> {
    // Record the swipe in database
    await pool.query(
      `INSERT INTO swipes (swiper_id, swiped_id, direction)
       VALUES ($1, $2, $3)
       ON CONFLICT (swiper_id, swiped_id) DO UPDATE SET direction = $3`,
      [swiperId, swipedId, direction]
    );

    // Add to Redis seen set
    const redisKey = direction === 'like' ? `swipes:${swiperId}:liked` : `swipes:${swiperId}:passed`;
    await redis.sadd(redisKey, swipedId);
    await redis.expire(redisKey, 86400);

    // If it's a like, check for mutual match
    if (direction === 'like') {
      // Add to received likes for the swiped user
      await redis.sadd(`likes:received:${swipedId}`, swiperId);
      await redis.expire(`likes:received:${swipedId}`, 86400);

      // Check if they liked us back
      const mutualLike = await redis.sismember(`swipes:${swipedId}:liked`, swiperId);

      if (mutualLike) {
        // It's a match!
        const match = await this.createMatch(swiperId, swipedId);
        return { match, isNewMatch: true };
      }

      // Check database as fallback
      const dbResult = await pool.query(
        `SELECT id FROM swipes
         WHERE swiper_id = $1 AND swiped_id = $2 AND direction = 'like'`,
        [swipedId, swiperId]
      );

      if (dbResult.rows.length > 0) {
        const match = await this.createMatch(swiperId, swipedId);
        return { match, isNewMatch: true };
      }
    }

    return { match: null, isNewMatch: false };
  }

  // Create a match between two users
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

  // Get all matches for a user
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

  // Check if two users are matched
  async areMatched(userId1: string, userId2: string): Promise<Match | null> {
    const [first, second] = userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];

    const result = await pool.query(
      'SELECT * FROM matches WHERE user1_id = $1 AND user2_id = $2',
      [first, second]
    );

    return result.rows[0] || null;
  }

  // Get match by ID
  async getMatchById(matchId: string): Promise<Match | null> {
    const result = await pool.query(
      'SELECT * FROM matches WHERE id = $1',
      [matchId]
    );
    return result.rows[0] || null;
  }

  // Unmatch (delete match)
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

  // Get stats for admin dashboard
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
