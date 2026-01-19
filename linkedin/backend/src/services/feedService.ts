import { query, queryOne, execute } from '../utils/db.js';
import { cacheGet, cacheSet, cacheDel } from '../utils/redis.js';
import { getFirstDegreeConnections } from './connectionService.js';
import type { Post, PostComment, User } from '../types/index.js';

/**
 * Creates a new post in the feed.
 * Invalidates feed caches for the author's connections so they see the new post.
 *
 * @param userId - The author's user ID
 * @param content - The text content of the post
 * @param imageUrl - Optional image attachment URL
 * @returns The newly created post
 */
export async function createPost(
  userId: number,
  content: string,
  imageUrl?: string
): Promise<Post> {
  const post = await queryOne<Post>(
    `INSERT INTO posts (user_id, content, image_url)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, content, imageUrl || null]
  );

  // Invalidate feed caches for user's connections
  const connections = await getFirstDegreeConnections(userId);
  for (const connId of connections.slice(0, 50)) { // Limit to prevent too many cache ops
    await cacheDel(`feed:${connId}`);
  }

  return post!;
}

/**
 * Retrieves a single post by ID with author information.
 *
 * @param postId - The post's unique identifier
 * @returns The post with author details, or null if not found
 */
export async function getPostById(postId: number): Promise<Post | null> {
  return queryOne<Post>(
    `SELECT p.*,
            json_build_object(
              'id', u.id,
              'first_name', u.first_name,
              'last_name', u.last_name,
              'headline', u.headline,
              'profile_image_url', u.profile_image_url
            ) as author
     FROM posts p
     JOIN users u ON p.user_id = u.id
     WHERE p.id = $1`,
    [postId]
  );
}

/**
 * Updates an existing post.
 * Only the author can modify their posts.
 *
 * @param postId - The post's unique identifier
 * @param userId - The user ID (for ownership verification)
 * @param content - The new post content
 * @param imageUrl - Optional new image URL
 * @returns The updated post, or null if not found/unauthorized
 */
export async function updatePost(
  postId: number,
  userId: number,
  content: string,
  imageUrl?: string
): Promise<Post | null> {
  return queryOne<Post>(
    `UPDATE posts SET content = $3, image_url = $4, updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [postId, userId, content, imageUrl || null]
  );
}

/**
 * Deletes a post from the feed.
 * Only the author can delete their posts.
 *
 * @param postId - The post's unique identifier
 * @param userId - The user ID (for ownership verification)
 * @returns True if deleted, false if not found/unauthorized
 */
export async function deletePost(postId: number, userId: number): Promise<boolean> {
  const count = await execute(
    `DELETE FROM posts WHERE id = $1 AND user_id = $2`,
    [postId, userId]
  );
  return count > 0;
}

/**
 * Retrieves posts by a specific user.
 * Used for profile pages to show a user's activity.
 *
 * @param userId - The author's user ID
 * @param offset - Number of posts to skip (default: 0)
 * @param limit - Maximum posts to return (default: 20)
 * @returns Array of posts with author information
 */
export async function getUserPosts(userId: number, offset = 0, limit = 20): Promise<Post[]> {
  return query<Post>(
    `SELECT p.*,
            json_build_object(
              'id', u.id,
              'first_name', u.first_name,
              'last_name', u.last_name,
              'headline', u.headline,
              'profile_image_url', u.profile_image_url
            ) as author
     FROM posts p
     JOIN users u ON p.user_id = u.id
     WHERE p.user_id = $1
     ORDER BY p.created_at DESC
     OFFSET $2 LIMIT $3`,
    [userId, offset, limit]
  );
}

/**
 * Generates a personalized feed for a user.
 * Shows posts from the user and their 1st-degree connections.
 * Posts are ranked using a multi-factor scoring algorithm:
 * - Engagement (likes + comments * 2) weighted at 30%
 * - Recency with time decay weighted at 50%
 * - User's own posts get a 20-point boost
 *
 * @param userId - The user viewing the feed
 * @param offset - Number of posts to skip (default: 0)
 * @param limit - Maximum posts to return (default: 20)
 * @returns Array of ranked posts with author info and like status
 */
export async function getFeed(
  userId: number,
  offset = 0,
  limit = 20
): Promise<Post[]> {
  // Get first-degree connections
  const connections = await getFirstDegreeConnections(userId);
  const allUserIds = [userId, ...connections];

  if (allUserIds.length === 0) {
    return [];
  }

  // Get posts from self and connections with ranking
  const posts = await query<Post>(
    `SELECT p.*,
            json_build_object(
              'id', u.id,
              'first_name', u.first_name,
              'last_name', u.last_name,
              'headline', u.headline,
              'profile_image_url', u.profile_image_url
            ) as author,
            EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $1) as has_liked,
            -- Feed ranking score
            (
              -- Engagement score (likes + comments * 2)
              (p.like_count + p.comment_count * 2) * 0.3 +
              -- Recency score (decay over time)
              GREATEST(0, 100 - EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600) * 0.5 +
              -- Author relationship (own posts get boost)
              CASE WHEN p.user_id = $1 THEN 20 ELSE 0 END
            ) as rank_score
     FROM posts p
     JOIN users u ON p.user_id = u.id
     WHERE p.user_id = ANY($2::int[])
     ORDER BY rank_score DESC, p.created_at DESC
     OFFSET $3 LIMIT $4`,
    [userId, allUserIds, offset, limit]
  );

  return posts;
}

/**
 * Adds a like to a post.
 * Idempotent - calling multiple times has no additional effect.
 * Updates the post's like count for display.
 *
 * @param userId - The user liking the post
 * @param postId - The post to like
 */
export async function likePost(userId: number, postId: number): Promise<void> {
  await execute(
    `INSERT INTO post_likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, postId]
  );
  await execute(
    `UPDATE posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = $1) WHERE id = $1`,
    [postId]
  );
}

/**
 * Removes a like from a post.
 * Updates the post's like count for display.
 *
 * @param userId - The user unliking the post
 * @param postId - The post to unlike
 */
export async function unlikePost(userId: number, postId: number): Promise<void> {
  await execute(
    `DELETE FROM post_likes WHERE user_id = $1 AND post_id = $2`,
    [userId, postId]
  );
  await execute(
    `UPDATE posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = $1) WHERE id = $1`,
    [postId]
  );
}

/**
 * Adds a comment to a post.
 * Increments the post's comment count for display.
 *
 * @param postId - The post to comment on
 * @param userId - The user writing the comment
 * @param content - The comment text
 * @returns The newly created comment
 */
export async function addComment(
  postId: number,
  userId: number,
  content: string
): Promise<PostComment> {
  const comment = await queryOne<PostComment>(
    `INSERT INTO post_comments (post_id, user_id, content)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [postId, userId, content]
  );

  await execute(
    `UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1`,
    [postId]
  );

  return comment!;
}

/**
 * Retrieves comments for a post with author information.
 * Ordered chronologically (oldest first for threaded display).
 *
 * @param postId - The post's unique identifier
 * @param offset - Number of comments to skip (default: 0)
 * @param limit - Maximum comments to return (default: 50)
 * @returns Array of comments with author details
 */
export async function getPostComments(postId: number, offset = 0, limit = 50): Promise<PostComment[]> {
  return query<PostComment>(
    `SELECT c.*,
            json_build_object(
              'id', u.id,
              'first_name', u.first_name,
              'last_name', u.last_name,
              'headline', u.headline,
              'profile_image_url', u.profile_image_url
            ) as author
     FROM post_comments c
     JOIN users u ON c.user_id = u.id
     WHERE c.post_id = $1
     ORDER BY c.created_at ASC
     OFFSET $2 LIMIT $3`,
    [postId, offset, limit]
  );
}

/**
 * Deletes a comment from a post.
 * Only the comment author can delete it.
 * Decrements the post's comment count.
 *
 * @param commentId - The comment's unique identifier
 * @param userId - The user ID (for ownership verification)
 * @returns True if deleted, false if not found/unauthorized
 */
export async function deleteComment(commentId: number, userId: number): Promise<boolean> {
  const comment = await queryOne<{ post_id: number }>(
    `DELETE FROM post_comments WHERE id = $1 AND user_id = $2 RETURNING post_id`,
    [commentId, userId]
  );

  if (comment) {
    await execute(
      `UPDATE posts SET comment_count = GREATEST(0, comment_count - 1) WHERE id = $1`,
      [comment.post_id]
    );
    return true;
  }

  return false;
}

/**
 * Retrieves users who liked a post.
 * Used for displaying the "liked by" list.
 *
 * @param postId - The post's unique identifier
 * @param limit - Maximum users to return (default: 50)
 * @returns Array of users who liked the post
 */
export async function getPostLikes(postId: number, limit = 50): Promise<User[]> {
  return query<User>(
    `SELECT u.id, u.first_name, u.last_name, u.headline, u.profile_image_url
     FROM post_likes pl
     JOIN users u ON pl.user_id = u.id
     WHERE pl.post_id = $1
     ORDER BY pl.created_at DESC
     LIMIT $2`,
    [postId, limit]
  );
}
