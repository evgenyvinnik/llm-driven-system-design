import { Router, Request, Response } from 'express';
import multer from 'multer';
import { query } from '../services/db.js';
import { uploadProfilePicture } from '../services/storage.js';
import { requireAuth, optionalAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { timelineAdd } from '../services/redis.js';
import { followRateLimitMiddleware } from '../services/rateLimiter.js';
import logger from '../services/logger.js';
import { followsTotal } from '../services/metrics.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

interface UserRow {
  id: string;
  username: string;
  email?: string;
  display_name: string;
  bio: string | null;
  profile_picture_url: string | null;
  follower_count: number;
  following_count: number;
  post_count: number;
  is_private: boolean;
  role?: string;
  created_at: Date;
}

interface PostRow {
  id: string;
  caption: string;
  like_count: number;
  comment_count: number;
  created_at: Date;
  thumbnail: string;
  media_count: string;
  saved_at?: Date;
}

interface FollowUserRow {
  id: string;
  username: string;
  display_name: string;
  profile_picture_url: string | null;
  created_at: Date;
}

// Get user profile
router.get('/:username', optionalAuth as express.RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const { username } = req.params;
    const authReq = req as AuthenticatedRequest;
    const currentUserId = authReq.session?.userId;

    const result = await query<UserRow>(
      `SELECT id, username, display_name, bio, profile_picture_url,
              follower_count, following_count, post_count, is_private, created_at
       FROM users WHERE username = $1`,
      [username.toLowerCase()]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = result.rows[0];

    const profileData: Record<string, unknown> = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      bio: user.bio,
      profilePictureUrl: user.profile_picture_url,
      followerCount: user.follower_count,
      followingCount: user.following_count,
      postCount: user.post_count,
      isPrivate: user.is_private,
      createdAt: user.created_at,
    };

    // Check if current user follows this user
    if (currentUserId && currentUserId !== user.id) {
      const followCheck = await query<{ '1': number }>(
        'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
        [currentUserId, user.id]
      );
      profileData.isFollowing = followCheck.rows.length > 0;
    }

    res.json({ user: profileData });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'get_user_error',
        error: err.message,
        username: req.params.username,
      },
      `Get user error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user profile
router.put(
  '/me',
  requireAuth as express.RequestHandler,
  upload.single('profilePicture'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.session.userId!;
      const { displayName, bio, isPrivate } = req.body as {
        displayName?: string;
        bio?: string;
        isPrivate?: string | boolean;
      };

      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (displayName !== undefined) {
        updates.push(`display_name = $${paramIndex++}`);
        values.push(displayName);
      }

      if (bio !== undefined) {
        updates.push(`bio = $${paramIndex++}`);
        values.push(bio);
      }

      if (isPrivate !== undefined) {
        updates.push(`is_private = $${paramIndex++}`);
        values.push(isPrivate === 'true' || isPrivate === true);
      }

      if (req.file) {
        const profileUrl = await uploadProfilePicture(req.file.buffer);
        updates.push(`profile_picture_url = $${paramIndex++}`);
        values.push(profileUrl);
      }

      if (updates.length === 0) {
        res.status(400).json({ error: 'No updates provided' });
        return;
      }

      values.push(userId);

      const result = await query<UserRow>(
        `UPDATE users SET ${updates.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING id, username, email, display_name, bio, profile_picture_url,
                   follower_count, following_count, post_count, is_private, role`,
        values
      );

      const user = result.rows[0];

      logger.info(
        {
          type: 'profile_updated',
          userId,
          updates: updates.map((u) => u.split(' = ')[0]),
        },
        `Profile updated: ${userId}`
      );

      res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          displayName: user.display_name,
          bio: user.bio,
          profilePictureUrl: user.profile_picture_url,
          followerCount: user.follower_count,
          followingCount: user.following_count,
          postCount: user.post_count,
          isPrivate: user.is_private,
          role: user.role,
        },
      });
    } catch (error) {
      const err = error as Error;
      const authReq = req as AuthenticatedRequest;
      logger.error(
        {
          type: 'update_profile_error',
          error: err.message,
          userId: authReq.session.userId,
        },
        `Update user error: ${err.message}`
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Get user posts
router.get('/:username/posts', optionalAuth as express.RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const { username } = req.params;
    const { cursor, limit = '12' } = req.query as { cursor?: string; limit?: string };
    const limitNum = parseInt(limit, 10);
    const authReq = req as AuthenticatedRequest;

    // Get user
    const userResult = await query<{ id: string; is_private: boolean }>(
      'SELECT id, is_private FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = userResult.rows[0];

    // Check if private and not following
    if (user.is_private && authReq.session?.userId !== user.id) {
      const followCheck = await query<{ '1': number }>(
        'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
        [authReq.session?.userId, user.id]
      );
      if (followCheck.rows.length === 0) {
        res.status(403).json({ error: 'This account is private' });
        return;
      }
    }

    let queryText = `
      SELECT p.id, p.caption, p.like_count, p.comment_count, p.created_at,
             (SELECT media_url FROM post_media WHERE post_id = p.id ORDER BY order_index LIMIT 1) as thumbnail,
             (SELECT COUNT(*) FROM post_media WHERE post_id = p.id) as media_count
      FROM posts p
      WHERE p.user_id = $1
    `;
    const params: unknown[] = [user.id];

    if (cursor) {
      queryText += ` AND p.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limitNum + 1);

    const result = await query<PostRow>(queryText, params);

    const hasMore = result.rows.length > limitNum;
    const posts = result.rows.slice(0, limitNum);

    res.json({
      posts: posts.map((p) => ({
        id: p.id,
        thumbnail: p.thumbnail,
        likeCount: p.like_count,
        commentCount: p.comment_count,
        mediaCount: parseInt(p.media_count, 10),
        createdAt: p.created_at,
      })),
      nextCursor: hasMore ? posts[posts.length - 1].created_at : null,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'get_user_posts_error',
        error: err.message,
        username: req.params.username,
      },
      `Get user posts error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's saved posts
router.get('/me/saved', requireAuth as express.RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;
    const { cursor, limit = '12' } = req.query as { cursor?: string; limit?: string };
    const limitNum = parseInt(limit, 10);

    let queryText = `
      SELECT p.id, p.caption, p.like_count, p.comment_count, p.created_at, sp.created_at as saved_at,
             (SELECT media_url FROM post_media WHERE post_id = p.id ORDER BY order_index LIMIT 1) as thumbnail,
             (SELECT COUNT(*) FROM post_media WHERE post_id = p.id) as media_count
      FROM saved_posts sp
      JOIN posts p ON sp.post_id = p.id
      WHERE sp.user_id = $1
    `;
    const params: unknown[] = [userId];

    if (cursor) {
      queryText += ` AND sp.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY sp.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limitNum + 1);

    const result = await query<PostRow>(queryText, params);

    const hasMore = result.rows.length > limitNum;
    const posts = result.rows.slice(0, limitNum);

    res.json({
      posts: posts.map((p) => ({
        id: p.id,
        thumbnail: p.thumbnail,
        likeCount: p.like_count,
        commentCount: p.comment_count,
        mediaCount: parseInt(p.media_count, 10),
        savedAt: p.saved_at,
      })),
      nextCursor: hasMore ? posts[posts.length - 1].saved_at : null,
    });
  } catch (error) {
    const err = error as Error;
    const authReq = req as AuthenticatedRequest;
    logger.error(
      {
        type: 'get_saved_posts_error',
        error: err.message,
        userId: authReq.session.userId,
      },
      `Get saved posts error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Follow user - with rate limiting
 */
router.post(
  '/:userId/follow',
  requireAuth as express.RequestHandler,
  followRateLimitMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId: targetUserId } = req.params;
      const authReq = req as AuthenticatedRequest;
      const currentUserId = authReq.session.userId!;

      if (targetUserId === currentUserId) {
        res.status(400).json({ error: 'Cannot follow yourself' });
        return;
      }

      // Check if target user exists
      const userCheck = await query<{ id: string; username: string }>('SELECT id, username FROM users WHERE id = $1', [
        targetUserId,
      ]);
      if (userCheck.rows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Insert follow - idempotent with ON CONFLICT
      const result = await query<{ id: string }>(
        'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
        [currentUserId, targetUserId]
      );

      if (result.rows.length === 0) {
        // Already following - idempotent response
        res.json({ message: 'Already following user', idempotent: true });
        return;
      }

      // Track metrics
      followsTotal.labels('follow').inc();

      logger.info(
        {
          type: 'follow',
          followerId: currentUserId,
          followingId: targetUserId,
          targetUsername: userCheck.rows[0].username,
        },
        `User ${currentUserId} followed ${targetUserId}`
      );

      // Add target user's recent posts to follower's timeline
      const recentPosts = await query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [targetUserId]
      );

      for (const post of recentPosts.rows) {
        await timelineAdd(currentUserId, post.id, new Date(post.created_at).getTime());
      }

      res.json({ message: 'User followed', idempotent: false });
    } catch (error) {
      const err = error as Error;
      logger.error(
        {
          type: 'follow_error',
          error: err.message,
          targetUserId: req.params.userId,
        },
        `Follow user error: ${err.message}`
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Unfollow user
router.delete('/:userId/follow', requireAuth as express.RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId: targetUserId } = req.params;
    const authReq = req as AuthenticatedRequest;
    const currentUserId = authReq.session.userId!;

    const result = await query<{ id: string }>(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING id',
      [currentUserId, targetUserId]
    );

    if (result.rows.length === 0) {
      // Already not following - idempotent response
      res.json({ message: 'Was not following user', idempotent: true });
      return;
    }

    // Track metrics
    followsTotal.labels('unfollow').inc();

    logger.info(
      {
        type: 'unfollow',
        followerId: currentUserId,
        followingId: targetUserId,
      },
      `User ${currentUserId} unfollowed ${targetUserId}`
    );

    res.json({ message: 'User unfollowed', idempotent: false });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'unfollow_error',
        error: err.message,
        targetUserId: req.params.userId,
      },
      `Unfollow user error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user followers
router.get('/:username/followers', async (req: Request, res: Response): Promise<void> => {
  try {
    const { username } = req.params;
    const { cursor, limit = '20' } = req.query as { cursor?: string; limit?: string };
    const limitNum = parseInt(limit, 10);

    const userResult = await query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const userId = userResult.rows[0].id;

    let queryText = `
      SELECT u.id, u.username, u.display_name, u.profile_picture_url, f.created_at
      FROM follows f
      JOIN users u ON f.follower_id = u.id
      WHERE f.following_id = $1
    `;
    const params: unknown[] = [userId];

    if (cursor) {
      queryText += ` AND f.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY f.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limitNum + 1);

    const result = await query<FollowUserRow>(queryText, params);

    const hasMore = result.rows.length > limitNum;
    const followers = result.rows.slice(0, limitNum);

    res.json({
      followers: followers.map((f) => ({
        id: f.id,
        username: f.username,
        displayName: f.display_name,
        profilePictureUrl: f.profile_picture_url,
      })),
      nextCursor: hasMore ? followers[followers.length - 1].created_at : null,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'get_followers_error',
        error: err.message,
        username: req.params.username,
      },
      `Get followers error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user following
router.get('/:username/following', async (req: Request, res: Response): Promise<void> => {
  try {
    const { username } = req.params;
    const { cursor, limit = '20' } = req.query as { cursor?: string; limit?: string };
    const limitNum = parseInt(limit, 10);

    const userResult = await query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const userId = userResult.rows[0].id;

    let queryText = `
      SELECT u.id, u.username, u.display_name, u.profile_picture_url, f.created_at
      FROM follows f
      JOIN users u ON f.following_id = u.id
      WHERE f.follower_id = $1
    `;
    const params: unknown[] = [userId];

    if (cursor) {
      queryText += ` AND f.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY f.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limitNum + 1);

    const result = await query<FollowUserRow>(queryText, params);

    const hasMore = result.rows.length > limitNum;
    const following = result.rows.slice(0, limitNum);

    res.json({
      following: following.map((f) => ({
        id: f.id,
        username: f.username,
        displayName: f.display_name,
        profilePictureUrl: f.profile_picture_url,
      })),
      nextCursor: hasMore ? following[following.length - 1].created_at : null,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'get_following_error',
        error: err.message,
        username: req.params.username,
      },
      `Get following error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search users
router.get('/search/users', async (req: Request, res: Response): Promise<void> => {
  try {
    const { q, limit = '20' } = req.query as { q?: string; limit?: string };
    const limitNum = parseInt(limit, 10);

    if (!q || q.length < 2) {
      res.json({ users: [] });
      return;
    }

    const result = await query<UserRow>(
      `SELECT id, username, display_name, profile_picture_url
       FROM users
       WHERE username ILIKE $1 OR display_name ILIKE $1
       ORDER BY follower_count DESC
       LIMIT $2`,
      [`%${q}%`, limitNum]
    );

    res.json({
      users: result.rows.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        profilePictureUrl: u.profile_picture_url,
      })),
    });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'search_users_error',
        error: err.message,
      },
      `Search users error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
