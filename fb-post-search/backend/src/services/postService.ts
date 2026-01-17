import { query, queryOne } from '../config/database.js';
import { indexPost, updatePostIndex, deletePostFromIndex } from './indexingService.js';
import type { Post, Visibility, PostType } from '../types/index.js';

interface PostRow extends Post {
  author_name?: string;
}

// Create a new post
export async function createPost(
  authorId: string,
  content: string,
  visibility: Visibility = 'friends',
  postType: PostType = 'text',
  mediaUrl?: string
): Promise<Post | null> {
  try {
    const post = await queryOne<Post>(
      `INSERT INTO posts (author_id, content, visibility, post_type, media_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [authorId, content, visibility, postType, mediaUrl]
    );

    if (post) {
      // Get author name for indexing
      interface UserRow {
        display_name: string;
      }
      const user = await queryOne<UserRow>('SELECT display_name FROM users WHERE id = $1', [authorId]);
      if (user) {
        await indexPost(post, user.display_name);
      }
    }

    return post;
  } catch (error) {
    console.error('Error creating post:', error);
    return null;
  }
}

// Get post by ID
export async function getPostById(postId: string): Promise<PostRow | null> {
  return queryOne<PostRow>(
    `SELECT p.*, u.display_name as author_name
     FROM posts p
     JOIN users u ON p.author_id = u.id
     WHERE p.id = $1`,
    [postId]
  );
}

// Get posts by author
export async function getPostsByAuthor(
  authorId: string,
  limit: number = 20,
  offset: number = 0
): Promise<PostRow[]> {
  return query<PostRow>(
    `SELECT p.*, u.display_name as author_name
     FROM posts p
     JOIN users u ON p.author_id = u.id
     WHERE p.author_id = $1
     ORDER BY p.created_at DESC
     LIMIT $2 OFFSET $3`,
    [authorId, limit, offset]
  );
}

// Update post
export async function updatePost(
  postId: string,
  content?: string,
  visibility?: Visibility
): Promise<Post | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (content !== undefined) {
    updates.push(`content = $${paramIndex++}`);
    values.push(content);
  }

  if (visibility !== undefined) {
    updates.push(`visibility = $${paramIndex++}`);
    values.push(visibility);
  }

  if (updates.length === 0) {
    return getPostById(postId);
  }

  values.push(postId);

  const post = await queryOne<Post>(
    `UPDATE posts SET ${updates.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING *`,
    values
  );

  if (post) {
    await updatePostIndex(postId);
  }

  return post;
}

// Delete post
export async function deletePost(postId: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    'DELETE FROM posts WHERE id = $1 RETURNING id',
    [postId]
  );

  if (result.length > 0) {
    await deletePostFromIndex(postId);
    return true;
  }

  return false;
}

// Like a post
export async function likePost(postId: string): Promise<Post | null> {
  const post = await queryOne<Post>(
    `UPDATE posts SET like_count = like_count + 1
     WHERE id = $1
     RETURNING *`,
    [postId]
  );

  if (post) {
    await updatePostIndex(postId);
  }

  return post;
}

// Get recent posts (for feed - respects visibility)
export async function getRecentPosts(
  userId: string,
  limit: number = 20,
  offset: number = 0
): Promise<PostRow[]> {
  // Get friend IDs
  interface FriendRow {
    friend_id: string;
  }
  const friends = await query<FriendRow>(
    `SELECT friend_id FROM friendships WHERE user_id = $1 AND status = 'accepted'`,
    [userId]
  );
  const friendIds = friends.map((f) => f.friend_id);

  // Get posts that user can see
  return query<PostRow>(
    `SELECT p.*, u.display_name as author_name
     FROM posts p
     JOIN users u ON p.author_id = u.id
     WHERE (
       p.visibility = 'public'
       OR p.author_id = $1
       OR (p.visibility = 'friends' AND p.author_id = ANY($2))
     )
     ORDER BY p.created_at DESC
     LIMIT $3 OFFSET $4`,
    [userId, friendIds, limit, offset]
  );
}

// Get all posts (admin only)
export async function getAllPosts(limit: number = 50, offset: number = 0): Promise<PostRow[]> {
  return query<PostRow>(
    `SELECT p.*, u.display_name as author_name
     FROM posts p
     JOIN users u ON p.author_id = u.id
     ORDER BY p.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
}

// Get post stats (admin only)
export async function getPostStats(): Promise<{
  total_posts: number;
  posts_today: number;
  posts_this_week: number;
  by_visibility: Record<string, number>;
  by_type: Record<string, number>;
}> {
  interface CountRow {
    count: string;
  }

  const total = await queryOne<CountRow>('SELECT COUNT(*) as count FROM posts');
  const today = await queryOne<CountRow>(
    `SELECT COUNT(*) as count FROM posts WHERE created_at >= CURRENT_DATE`
  );
  const thisWeek = await queryOne<CountRow>(
    `SELECT COUNT(*) as count FROM posts WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`
  );

  interface VisibilityRow {
    visibility: string;
    count: string;
  }
  const byVisibility = await query<VisibilityRow>(
    `SELECT visibility, COUNT(*) as count FROM posts GROUP BY visibility`
  );

  interface TypeRow {
    post_type: string;
    count: string;
  }
  const byType = await query<TypeRow>(
    `SELECT post_type, COUNT(*) as count FROM posts GROUP BY post_type`
  );

  return {
    total_posts: parseInt(total?.count || '0', 10),
    posts_today: parseInt(today?.count || '0', 10),
    posts_this_week: parseInt(thisWeek?.count || '0', 10),
    by_visibility: Object.fromEntries(byVisibility.map((r) => [r.visibility, parseInt(r.count, 10)])),
    by_type: Object.fromEntries(byType.map((r) => [r.post_type, parseInt(r.count, 10)])),
  };
}
