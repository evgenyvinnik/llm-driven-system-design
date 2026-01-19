import { PoolClient } from 'pg';
import { query, transaction } from '../../utils/db.js';
import { cacheDelete } from '../../utils/redis.js';
import {
  CommentRow,
  CommentResponse,
  Pagination,
  CommentLikeResult,
  DatabaseError,
} from './types.js';

/**
 * @description Adds a new comment to a video.
 * Uses a database transaction to insert the comment and update the video's comment count.
 * Supports both top-level comments and replies to existing comments.
 * Invalidates the video cache after successful creation.
 * @param userId - The UUID of the user posting the comment
 * @param videoId - The UUID of the video being commented on
 * @param text - The comment text content
 * @param parentId - The UUID of the parent comment (null for top-level comments)
 * @returns The created comment response with user info
 * @throws Error if comment creation fails or user not found
 */
export const addComment = async (
  userId: string,
  videoId: string,
  text: string,
  parentId: string | null = null
): Promise<CommentResponse> => {
  const result = await transaction(async (client: PoolClient) => {
    const commentResult = await client.query<CommentRow>(
      `INSERT INTO comments (user_id, video_id, text, parent_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, videoId, text, parentId]
    );

    // Update comment count
    await client.query('UPDATE videos SET comment_count = comment_count + 1 WHERE id = $1', [
      videoId,
    ]);

    const row = commentResult.rows[0];
    if (!row) {
      throw new Error('Failed to create comment');
    }
    return row;
  });

  // Get user info for response
  const userResult = await query<{ username: string; avatar_url: string }>(
    'SELECT username, avatar_url FROM users WHERE id = $1',
    [userId]
  );

  const userRow = userResult.rows[0];
  if (!userRow) {
    throw new Error('User not found');
  }

  // Invalidate video cache
  await cacheDelete(`video:${videoId}`);

  return {
    id: result.id,
    text: result.text,
    likeCount: result.like_count,
    isEdited: result.is_edited,
    createdAt: result.created_at,
    user: {
      id: userId,
      username: userRow.username,
      avatarUrl: userRow.avatar_url,
    },
    parentId: result.parent_id,
  };
};

/**
 * @description Retrieves a paginated list of comments for a video.
 * Can fetch either top-level comments (parentId = null) or replies to a specific comment.
 * Results are sorted by like count (descending) and then by creation date (descending).
 * Includes reply count for each comment.
 * @param videoId - The UUID of the video to get comments for
 * @param page - Page number for pagination (1-indexed, defaults to 1)
 * @param limit - Number of comments per page (defaults to 20)
 * @param parentId - The UUID of the parent comment to get replies for (null for top-level)
 * @returns Object containing the comments array and pagination metadata
 */
export const getComments = async (
  videoId: string,
  page: number = 1,
  limit: number = 20,
  parentId: string | null = null
): Promise<{ comments: CommentResponse[]; pagination: Pagination }> => {
  const offset = (page - 1) * limit;

  const whereClause = parentId
    ? 'WHERE c.video_id = $1 AND c.parent_id = $2'
    : 'WHERE c.video_id = $1 AND c.parent_id IS NULL';

  const params: unknown[] = parentId ? [videoId, parentId] : [videoId];

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) FROM comments c ${whereClause}`,
    params
  );

  const countRow = countResult.rows[0];
  const total = countRow ? parseInt(countRow.count, 10) : 0;

  params.push(limit, offset);

  const result = await query<CommentRow>(
    `SELECT c.*, u.username, u.avatar_url,
            (SELECT COUNT(*) FROM comments WHERE parent_id = c.id) as reply_count
     FROM comments c
     JOIN users u ON c.user_id = u.id
     ${whereClause}
     ORDER BY c.like_count DESC, c.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    comments: result.rows.map((c) => ({
      id: c.id,
      text: c.text,
      likeCount: c.like_count,
      isEdited: c.is_edited,
      createdAt: c.created_at,
      replyCount: parseInt(c.reply_count || '0', 10),
      user: {
        id: c.user_id,
        username: c.username || '',
        avatarUrl: c.avatar_url || '',
      },
      parentId: c.parent_id,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

/**
 * @description Deletes a comment from a video.
 * Only the comment author can delete their own comment.
 * Uses a database transaction to delete the comment and decrement the video's comment count.
 * Invalidates the video cache after successful deletion.
 * @param commentId - The UUID of the comment to delete
 * @param userId - The UUID of the user attempting deletion (must be comment author)
 * @returns True if the comment was deleted, false if not found or user not authorized
 */
export const deleteComment = async (commentId: string, userId: string): Promise<boolean> => {
  const result = await transaction(async (client: PoolClient) => {
    const comment = await client.query<{ video_id: string }>(
      'SELECT video_id FROM comments WHERE id = $1 AND user_id = $2',
      [commentId, userId]
    );

    const commentRow = comment.rows[0];
    if (!commentRow) {
      return null;
    }

    const videoId = commentRow.video_id;

    await client.query('DELETE FROM comments WHERE id = $1', [commentId]);

    await client.query('UPDATE videos SET comment_count = comment_count - 1 WHERE id = $1', [
      videoId,
    ]);

    return videoId;
  });

  if (result) {
    await cacheDelete(`video:${result}`);
  }

  return result !== null;
};

/**
 * @description Toggles a like on a comment.
 * If the user hasn't liked the comment, adds a like.
 * If the user has already liked the comment, removes the like.
 * Updates the comment's like count accordingly.
 * @param userId - The UUID of the user liking/unliking the comment
 * @param commentId - The UUID of the comment to like/unlike
 * @returns Result indicating whether the comment is now liked (true) or unliked (false)
 * @throws Re-throws database errors other than unique constraint violations
 */
export const likeComment = async (
  userId: string,
  commentId: string
): Promise<CommentLikeResult> => {
  try {
    await query('INSERT INTO comment_likes (user_id, comment_id) VALUES ($1, $2)', [
      userId,
      commentId,
    ]);

    await query('UPDATE comments SET like_count = like_count + 1 WHERE id = $1', [commentId]);

    return { liked: true };
  } catch (error) {
    const dbError = error as DatabaseError;
    if (dbError.code === '23505') {
      // Already liked, unlike
      await query('DELETE FROM comment_likes WHERE user_id = $1 AND comment_id = $2', [
        userId,
        commentId,
      ]);

      await query('UPDATE comments SET like_count = like_count - 1 WHERE id = $1', [commentId]);

      return { liked: false };
    }
    throw error;
  }
};
