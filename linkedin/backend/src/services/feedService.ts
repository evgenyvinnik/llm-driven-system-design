import { query, queryOne, execute } from '../utils/db.js';
import { cacheGet, cacheSet, cacheDel } from '../utils/redis.js';
import { getFirstDegreeConnections } from './connectionService.js';
import type { Post, PostComment, User } from '../types/index.js';

// Create a post
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

// Get post by ID
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

// Update post
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

// Delete post
export async function deletePost(postId: number, userId: number): Promise<boolean> {
  const count = await execute(
    `DELETE FROM posts WHERE id = $1 AND user_id = $2`,
    [postId, userId]
  );
  return count > 0;
}

// Get user's posts
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

// Get feed for user (posts from connections)
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

// Like a post
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

// Unlike a post
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

// Add comment
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

// Get comments for a post
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

// Delete comment
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

// Get post likes
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
