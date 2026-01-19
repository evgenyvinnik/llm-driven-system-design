/**
 * Comment Service Module
 *
 * Handles all comment operations for live streams including creation, retrieval,
 * deletion, and moderation actions. Implements rate limiting, content filtering,
 * idempotency, and observability to prevent spam and ensure reliability during
 * high-traffic broadcasts.
 *
 * @module services/commentService
 */

import { query } from '../db/index.js';
import { Comment, CommentWithUser } from '../types/index.js';
import { snowflake } from '../utils/snowflake.js';
import { redis, checkRateLimit } from '../utils/redis.js';
import { streamService } from './streamService.js';
import {
  logger,
  commentsPostedCounter,
  commentLatencyHistogram,
  rateLimitExceededCounter,
  checkIdempotencyKey,
  storeIdempotencyResult,
  generateIdempotencyKey,
} from '../shared/index.js';

const commentLogger = logger.child({ module: 'comment-service' });

/** Simple word filter for basic content moderation (production should use ML-based filtering) */
const BANNED_WORDS = ['spam', 'scam', 'fake'];

/**
 * Service class for comment management operations.
 * Handles real-time comment posting with rate limiting, idempotency, and caching.
 */
export class CommentService {
  /** Maximum comments per user globally per minute */
  private rateLimitGlobal: number;

  /** Maximum comments per user per stream per 30 seconds */
  private rateLimitPerStream: number;

  /**
   * Creates a new CommentService instance with rate limit configuration.
   * Reads limits from environment variables or uses defaults.
   */
  constructor() {
    this.rateLimitGlobal = parseInt(process.env.RATE_LIMIT_COMMENTS_PER_MINUTE || '30', 10);
    this.rateLimitPerStream = parseInt(process.env.RATE_LIMIT_COMMENTS_PER_STREAM || '5', 10);
  }

  /**
   * Creates a new comment on a stream with idempotency support.
   *
   * Performs the following steps:
   * 1. Checks idempotency key for duplicate prevention
   * 2. Checks global and per-stream rate limits
   * 3. Filters for banned words
   * 4. Generates a Snowflake ID for time-ordering
   * 5. Persists to database
   * 6. Updates stream comment count
   * 7. Caches for real-time delivery
   * 8. Stores idempotency result
   *
   * @param streamId - Target stream ID
   * @param userId - Author's user ID
   * @param content - Comment text content
   * @param parentId - Optional parent comment ID for replies
   * @param idempotencyKey - Optional client-provided idempotency key
   * @returns Created comment with user information
   * @throws Error if rate limited or content contains banned words
   */
  async createComment(
    streamId: string,
    userId: string,
    content: string,
    parentId?: string,
    idempotencyKey?: string
  ): Promise<CommentWithUser> {
    const startTime = Date.now();
    const reqLogger = commentLogger.child({ streamId, userId });

    // 0. Generate or use provided idempotency key
    const effectiveKey = idempotencyKey || generateIdempotencyKey(userId, streamId, content);

    // 1. Check for duplicate via idempotency
    const { isDuplicate, storedResult } = await checkIdempotencyKey<CommentWithUser>(effectiveKey);
    if (isDuplicate && storedResult) {
      reqLogger.info({ idempotencyKey: effectiveKey }, 'Returning cached comment (duplicate request)');
      return storedResult;
    }

    // 2. Check rate limits
    const globalAllowed = await checkRateLimit(
      `ratelimit:global:${userId}`,
      this.rateLimitGlobal,
      60
    );
    if (!globalAllowed) {
      reqLogger.warn('Global rate limit exceeded');
      rateLimitExceededCounter.labels('global', userId).inc();
      commentsPostedCounter.labels(streamId, 'rate_limited').inc();
      throw new Error('Rate limit exceeded: too many comments globally');
    }

    const streamAllowed = await checkRateLimit(
      `ratelimit:stream:${streamId}:${userId}`,
      this.rateLimitPerStream,
      30
    );
    if (!streamAllowed) {
      reqLogger.warn('Per-stream rate limit exceeded');
      rateLimitExceededCounter.labels('stream', userId).inc();
      commentsPostedCounter.labels(streamId, 'rate_limited').inc();
      throw new Error('Rate limit exceeded: too many comments in this stream');
    }

    // 3. Check for banned words
    const lowerContent = content.toLowerCase();
    for (const word of BANNED_WORDS) {
      if (lowerContent.includes(word)) {
        reqLogger.warn({ word }, 'Comment rejected due to banned word');
        commentsPostedCounter.labels(streamId, 'filtered').inc();
        throw new Error('Comment contains prohibited content');
      }
    }

    // 4. Generate Snowflake ID
    const commentId = snowflake.generate();

    // 5. Insert into database
    const rows = await query<CommentWithUser>(
      `INSERT INTO comments (id, stream_id, user_id, content, parent_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING
         id::text, stream_id, user_id, content, parent_id::text,
         is_highlighted, is_pinned, is_hidden, moderation_status, created_at`,
      [commentId.toString(), streamId, userId, content, parentId || null]
    );

    const comment = rows[0];

    // 6. Get user info
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

    // 7. Update stream comment count
    await streamService.incrementCommentCount(streamId);

    // 8. Build result and cache
    const commentWithUser: CommentWithUser = {
      ...comment,
      user,
    };

    await this.cacheComment(streamId, commentWithUser);

    // 9. Store idempotency result
    await storeIdempotencyResult(effectiveKey, commentWithUser);

    // 10. Record metrics
    const latency = Date.now() - startTime;
    commentLatencyHistogram.observe(latency);
    commentsPostedCounter.labels(streamId, 'success').inc();

    reqLogger.info({ commentId: commentId.toString(), latency }, 'Comment created successfully');

    return commentWithUser;
  }

  /**
   * Retrieves recent comments for a stream.
   * Tries Redis cache first for low latency, falls back to database.
   *
   * @param streamId - Stream to fetch comments for
   * @param limit - Maximum number of comments to return (default: 50)
   * @returns Array of comments with user information, newest first
   */
  async getRecentComments(streamId: string, limit = 50): Promise<CommentWithUser[]> {
    // Try cache first
    const cached = await redis.lrange(`recent:stream:${streamId}`, 0, limit - 1);
    if (cached.length > 0) {
      commentLogger.debug({ streamId, count: cached.length, source: 'cache' }, 'Retrieved comments from cache');
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

    commentLogger.debug({ streamId, count: rows.length, source: 'database' }, 'Retrieved comments from database');
    return rows;
  }

  /**
   * Soft-deletes a comment by marking it as hidden.
   * Only the comment author or moderators/admins can delete comments.
   *
   * @param commentId - ID of comment to delete
   * @param userId - User attempting the deletion
   * @returns true if deletion was successful, false if unauthorized or not found
   */
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

    const success = result.length > 0;
    if (success) {
      commentLogger.info({ commentId, userId }, 'Comment deleted');
    } else {
      commentLogger.warn({ commentId, userId }, 'Comment deletion failed - not found or unauthorized');
    }

    return success;
  }

  /**
   * Pins a comment to the top of the stream chat.
   * Only moderators and admins can pin comments.
   *
   * @param commentId - ID of comment to pin
   * @param userId - User attempting to pin (must be moderator/admin)
   * @returns true if pinning was successful, false if unauthorized
   */
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

    const success = result.length > 0;
    if (success) {
      commentLogger.info({ commentId, userId }, 'Comment pinned');
    }

    return success;
  }

  /**
   * Highlights a comment to make it more visible.
   * Only the stream creator can highlight comments in their stream.
   *
   * @param commentId - ID of comment to highlight
   * @param userId - User attempting to highlight (must be stream creator)
   * @returns true if highlighting was successful, false if unauthorized
   */
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

    const success = result.length > 0;
    if (success) {
      commentLogger.info({ commentId, userId }, 'Comment highlighted');
    }

    return success;
  }

  /**
   * Caches a comment in Redis for fast real-time retrieval.
   * Maintains a sliding window of the last 1000 comments per stream.
   *
   * @param streamId - Stream to cache the comment for
   * @param comment - Comment with user data to cache
   */
  private async cacheComment(streamId: string, comment: CommentWithUser): Promise<void> {
    const key = `recent:stream:${streamId}`;
    await redis.lpush(key, JSON.stringify(comment));
    await redis.ltrim(key, 0, 999); // Keep only last 1000 comments
    await redis.expire(key, 3600); // 1 hour TTL
  }
}

/** Singleton comment service instance */
export const commentService = new CommentService();
