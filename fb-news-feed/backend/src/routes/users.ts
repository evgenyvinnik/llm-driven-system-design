import { Router, Request, Response } from 'express';
import { pool } from '../db/connection.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import type { UpdateUserRequest, UserPublic } from '../types/index.js';

const router = Router();

// Get user profile
router.get('/:username', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { username } = req.params;

    const result = await pool.query(
      `SELECT id, username, display_name, bio, avatar_url, follower_count, following_count, is_celebrity, created_at
       FROM users
       WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = result.rows[0] as UserPublic;

    // Check if current user is following this user
    let is_following = false;
    if (req.user) {
      const followResult = await pool.query(
        `SELECT id FROM friendships
         WHERE follower_id = $1 AND following_id = $2 AND status = 'active'`,
        [req.user.id, user.id]
      );
      is_following = followResult.rows.length > 0;
    }

    res.json({
      ...user,
      is_following,
      is_self: req.user?.id === user.id,
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user profile
router.put('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { display_name, bio, avatar_url } = req.body as UpdateUserRequest;

    const updates: string[] = [];
    const values: (string | null)[] = [];
    let paramIndex = 1;

    if (display_name !== undefined) {
      updates.push(`display_name = $${paramIndex++}`);
      values.push(display_name);
    }
    if (bio !== undefined) {
      updates.push(`bio = $${paramIndex++}`);
      values.push(bio);
    }
    if (avatar_url !== undefined) {
      updates.push(`avatar_url = $${paramIndex++}`);
      values.push(avatar_url);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(userId);

    const result = await pool.query(
      `UPDATE users
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, username, display_name, bio, avatar_url, follower_count, following_count, is_celebrity, created_at`,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's posts
router.get('/:username/posts', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const cursor = req.query.cursor as string | undefined;

    // Get user ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const userId = userResult.rows[0].id;

    // Build query based on privacy
    let query = `
      SELECT p.*, u.id as author_id, u.username as author_username,
             u.display_name as author_display_name, u.avatar_url as author_avatar_url,
             u.is_celebrity as author_is_celebrity
      FROM posts p
      JOIN users u ON p.author_id = u.id
      WHERE p.author_id = $1 AND p.is_deleted = false
    `;

    const params: (string | number)[] = [userId];
    let paramIndex = 2;

    // Filter by privacy if not viewing own posts
    if (!req.user || req.user.id !== userId) {
      // Check if following
      let isFollowing = false;
      if (req.user) {
        const followResult = await pool.query(
          `SELECT id FROM friendships
           WHERE follower_id = $1 AND following_id = $2 AND status = 'active'`,
          [req.user.id, userId]
        );
        isFollowing = followResult.rows.length > 0;
      }

      if (!isFollowing) {
        query += ` AND p.privacy = 'public'`;
      }
    }

    if (cursor) {
      query += ` AND p.created_at < $${paramIndex++}`;
      params.push(cursor);
    }

    query += ` ORDER BY p.created_at DESC LIMIT $${paramIndex}`;
    params.push(limit + 1);

    const result = await pool.query(query, params);
    const posts = result.rows.slice(0, limit);
    const hasMore = result.rows.length > limit;

    // Check if current user liked each post
    if (req.user && posts.length > 0) {
      const postIds = posts.map((p: { id: string }) => p.id);
      const likesResult = await pool.query(
        `SELECT post_id FROM likes WHERE user_id = $1 AND post_id = ANY($2)`,
        [req.user.id, postIds]
      );
      const likedPostIds = new Set(likesResult.rows.map((r: { post_id: string }) => r.post_id));

      posts.forEach((post: { id: string; is_liked?: boolean }) => {
        post.is_liked = likedPostIds.has(post.id);
      });
    }

    // Format response
    const formattedPosts = posts.map((p: {
      id: string;
      content: string;
      image_url: string | null;
      post_type: string;
      privacy: string;
      like_count: number;
      comment_count: number;
      share_count: number;
      created_at: Date;
      updated_at: Date;
      is_liked?: boolean;
      author_id: string;
      author_username: string;
      author_display_name: string;
      author_avatar_url: string | null;
      author_is_celebrity: boolean;
    }) => ({
      id: p.id,
      content: p.content,
      image_url: p.image_url,
      post_type: p.post_type,
      privacy: p.privacy,
      like_count: p.like_count,
      comment_count: p.comment_count,
      share_count: p.share_count,
      created_at: p.created_at,
      updated_at: p.updated_at,
      is_liked: p.is_liked || false,
      author: {
        id: p.author_id,
        username: p.author_username,
        display_name: p.author_display_name,
        avatar_url: p.author_avatar_url,
        is_celebrity: p.author_is_celebrity,
      },
    }));

    res.json({
      posts: formattedPosts,
      cursor: hasMore ? posts[posts.length - 1].created_at : null,
      has_more: hasMore,
    });
  } catch (error) {
    console.error('Get user posts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's followers
router.get('/:username/followers', async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const userId = userResult.rows[0].id;

    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_celebrity
       FROM friendships f
       JOIN users u ON f.follower_id = u.id
       WHERE f.following_id = $1 AND f.status = 'active'
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    res.json({
      users: result.rows,
      has_more: result.rows.length === limit,
    });
  } catch (error) {
    console.error('Get followers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's following
router.get('/:username/following', async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const userId = userResult.rows[0].id;

    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_celebrity
       FROM friendships f
       JOIN users u ON f.following_id = u.id
       WHERE f.follower_id = $1 AND f.status = 'active'
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    res.json({
      users: result.rows,
      has_more: result.rows.length === limit,
    });
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Follow user
router.post('/:username/follow', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const followerId = req.user!.id;

    // Get user to follow
    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const followingId = userResult.rows[0].id;

    if (followerId === followingId) {
      res.status(400).json({ error: 'Cannot follow yourself' });
      return;
    }

    // Check if already following
    const existingFollow = await pool.query(
      'SELECT id FROM friendships WHERE follower_id = $1 AND following_id = $2',
      [followerId, followingId]
    );

    if (existingFollow.rows.length > 0) {
      res.status(409).json({ error: 'Already following this user' });
      return;
    }

    // Create friendship
    await pool.query(
      `INSERT INTO friendships (follower_id, following_id, status)
       VALUES ($1, $2, 'active')`,
      [followerId, followingId]
    );

    // Update counts
    await pool.query(
      'UPDATE users SET following_count = following_count + 1 WHERE id = $1',
      [followerId]
    );
    await pool.query(
      'UPDATE users SET follower_count = follower_count + 1 WHERE id = $1',
      [followingId]
    );

    // Trigger fan-out for existing posts from followed user (for non-celebrities)
    const followedUserResult = await pool.query(
      'SELECT is_celebrity FROM users WHERE id = $1',
      [followingId]
    );

    if (!followedUserResult.rows[0].is_celebrity) {
      // Add recent posts to follower's feed
      await pool.query(
        `INSERT INTO feed_items (user_id, post_id, score, created_at)
         SELECT $1, id, EXTRACT(EPOCH FROM created_at) as score, created_at
         FROM posts
         WHERE author_id = $2 AND is_deleted = false
         ORDER BY created_at DESC
         LIMIT 20
         ON CONFLICT (user_id, post_id) DO NOTHING`,
        [followerId, followingId]
      );
    }

    res.json({ message: 'Successfully followed user' });
  } catch (error) {
    console.error('Follow error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unfollow user
router.delete('/:username/follow', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const followerId = req.user!.id;

    // Get user to unfollow
    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const followingId = userResult.rows[0].id;

    // Delete friendship
    const result = await pool.query(
      `DELETE FROM friendships
       WHERE follower_id = $1 AND following_id = $2
       RETURNING id`,
      [followerId, followingId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Not following this user' });
      return;
    }

    // Update counts
    await pool.query(
      'UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id = $1',
      [followerId]
    );
    await pool.query(
      'UPDATE users SET follower_count = GREATEST(follower_count - 1, 0) WHERE id = $1',
      [followingId]
    );

    // Remove posts from unfollowed user from feed
    await pool.query(
      `DELETE FROM feed_items
       WHERE user_id = $1 AND post_id IN (
         SELECT id FROM posts WHERE author_id = $2
       )`,
      [followerId, followingId]
    );

    res.json({ message: 'Successfully unfollowed user' });
  } catch (error) {
    console.error('Unfollow error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search users
router.get('/', async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    const limit = parseInt(req.query.limit as string) || 20;

    if (!query || query.length < 2) {
      res.status(400).json({ error: 'Search query must be at least 2 characters' });
      return;
    }

    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url, is_celebrity, follower_count
       FROM users
       WHERE username ILIKE $1 OR display_name ILIKE $1
       ORDER BY follower_count DESC
       LIMIT $2`,
      [`%${query}%`, limit]
    );

    res.json({ users: result.rows });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
