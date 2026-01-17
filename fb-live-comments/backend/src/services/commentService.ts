import { query } from '../db/index.js';
import { Comment, CommentWithUser } from '../types/index.js';
import { snowflake } from '../utils/snowflake.js';
import { redis, checkRateLimit } from '../utils/redis.js';
import { streamService } from './streamService.js';

// Simple profanity filter (in production, use a proper library or ML model)
const BANNED_WORDS = ['spam', 'scam', 'fake'];

export class CommentService {
  private rateLimitGlobal: number;
  private rateLimitPerStream: number;

  constructor() {
    this.rateLimitGlobal = parseInt(process.env.RATE_LIMIT_COMMENTS_PER_MINUTE || '30', 10);
    this.rateLimitPerStream = parseInt(process.env.RATE_LIMIT_COMMENTS_PER_STREAM || '5', 10);
  }

  async createComment(
    streamId: string,
    userId: string,
    content: string,
    parentId?: string
  ): Promise<CommentWithUser> {
    // 1. Check rate limits
    const globalAllowed = await checkRateLimit(
      `ratelimit:global:${userId}`,
      this.rateLimitGlobal,
      60
    );
    if (!globalAllowed) {
      throw new Error('Rate limit exceeded: too many comments globally');
    }

    const streamAllowed = await checkRateLimit(
      `ratelimit:stream:${streamId}:${userId}`,
      this.rateLimitPerStream,
      30
    );
    if (!streamAllowed) {
      throw new Error('Rate limit exceeded: too many comments in this stream');
    }

    // 2. Check for banned words
    const lowerContent = content.toLowerCase();
    for (const word of BANNED_WORDS) {
      if (lowerContent.includes(word)) {
        throw new Error('Comment contains prohibited content');
      }
    }

    // 3. Generate Snowflake ID
    const commentId = snowflake.generate();

    // 4. Insert into database
    const rows = await query<CommentWithUser>(
      `INSERT INTO comments (id, stream_id, user_id, content, parent_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING
         id::text, stream_id, user_id, content, parent_id::text,
         is_highlighted, is_pinned, is_hidden, moderation_status, created_at`,
      [commentId.toString(), streamId, userId, content, parentId || null]
    );

    const comment = rows[0];

    // 5. Get user info
    const userRows = await query<{
      username: string;
      display_name: string;
      avatar_url: string | null;
      is_verified: boolean;
    }>(
      'SELECT username, display_name, avatar_url, is_verified FROM users WHERE id = $1',
      [userId]
    );

    const user = userRows[0];
    if (!user) {
      throw new Error('User not found');
    }

    // 6. Update stream comment count
    await streamService.incrementCommentCount(streamId);

    // 7. Add to recent comments cache
    const commentWithUser: CommentWithUser = {
      ...comment,
      user,
    };

    await this.cacheComment(streamId, commentWithUser);

    return commentWithUser;
  }

  async getRecentComments(streamId: string, limit = 50): Promise<CommentWithUser[]> {
    // Try cache first
    const cached = await redis.lrange(`recent:stream:${streamId}`, 0, limit - 1);
    if (cached.length > 0) {
      return cached.map((c) => JSON.parse(c) as CommentWithUser);
    }

    // Fall back to database
    const rows = await query<CommentWithUser>(
      `SELECT
         c.id::text, c.stream_id, c.user_id, c.content, c.parent_id::text,
         c.is_highlighted, c.is_pinned, c.is_hidden, c.moderation_status, c.created_at,
         json_build_object(
           'username', u.username,
           'display_name', u.display_name,
           'avatar_url', u.avatar_url,
           'is_verified', u.is_verified
         ) as user
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.stream_id = $1 AND c.is_hidden = false AND c.moderation_status = 'approved'
       ORDER BY c.id DESC
       LIMIT $2`,
      [streamId, limit]
    );

    return rows;
  }

  async deleteComment(commentId: string, userId: string): Promise<boolean> {
    // Check if user owns the comment or is a moderator
    const result = await query(
      `UPDATE comments SET is_hidden = true
       WHERE id = $1 AND (user_id = $2 OR EXISTS (
         SELECT 1 FROM users WHERE id = $2 AND role IN ('moderator', 'admin')
       ))
       RETURNING id`,
      [commentId, userId]
    );

    return result.length > 0;
  }

  async pinComment(commentId: string, userId: string): Promise<boolean> {
    // Only moderators and admins can pin
    const result = await query(
      `UPDATE comments SET is_pinned = true
       WHERE id = $1 AND EXISTS (
         SELECT 1 FROM users WHERE id = $2 AND role IN ('moderator', 'admin')
       )
       RETURNING id`,
      [commentId, userId]
    );

    return result.length > 0;
  }

  async highlightComment(commentId: string, userId: string): Promise<boolean> {
    // Stream creators can highlight comments
    const result = await query(
      `UPDATE comments c SET is_highlighted = true
       WHERE c.id = $1 AND EXISTS (
         SELECT 1 FROM streams s WHERE s.id = c.stream_id AND s.creator_id = $2
       )
       RETURNING id`,
      [commentId, userId]
    );

    return result.length > 0;
  }

  private async cacheComment(streamId: string, comment: CommentWithUser): Promise<void> {
    const key = `recent:stream:${streamId}`;
    await redis.lpush(key, JSON.stringify(comment));
    await redis.ltrim(key, 0, 999); // Keep only last 1000 comments
    await redis.expire(key, 3600); // 1 hour TTL
  }
}

export const commentService = new CommentService();
