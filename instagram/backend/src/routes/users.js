import { Router } from 'express';
import multer from 'multer';
import { query } from '../services/db.js';
import { uploadProfilePicture } from '../services/storage.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { timelineAdd, cacheGet, cacheSet, cacheDel } from '../services/redis.js';
import { followRateLimitMiddleware } from '../services/rateLimiter.js';
import logger from '../services/logger.js';
import { followsTotal } from '../services/metrics.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Get user profile
router.get('/:username', optionalAuth, async (req, res) => {
  try {
    const { username } = req.params;
    const currentUserId = req.session?.userId;

    const result = await query(
      `SELECT id, username, display_name, bio, profile_picture_url,
              follower_count, following_count, post_count, is_private, created_at
       FROM users WHERE username = $1`,
      [username.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    const profileData = {
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
      const followCheck = await query(
        'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
        [currentUserId, user.id]
      );
      profileData.isFollowing = followCheck.rows.length > 0;
    }

    res.json({ user: profileData });
  } catch (error) {
    logger.error({
      type: 'get_user_error',
      error: error.message,
      username: req.params.username,
    }, `Get user error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user profile
router.put('/me', requireAuth, upload.single('profilePicture'), async (req, res) => {
  try {
    const userId = req.session.userId;
    const { displayName, bio, isPrivate } = req.body;

    const updates = [];
    const values = [];
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
      return res.status(400).json({ error: 'No updates provided' });
    }

    values.push(userId);

    const result = await query(
      `UPDATE users SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, username, email, display_name, bio, profile_picture_url,
                 follower_count, following_count, post_count, is_private, role`,
      values
    );

    const user = result.rows[0];

    logger.info({
      type: 'profile_updated',
      userId,
      updates: updates.map((u) => u.split(' = ')[0]),
    }, `Profile updated: ${userId}`);

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
    logger.error({
      type: 'update_profile_error',
      error: error.message,
      userId: req.session.userId,
    }, `Update user error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user posts
router.get('/:username/posts', optionalAuth, async (req, res) => {
  try {
    const { username } = req.params;
    const { cursor, limit = 12 } = req.query;

    // Get user
    const userResult = await query(
      'SELECT id, is_private FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Check if private and not following
    if (user.is_private && req.session?.userId !== user.id) {
      const followCheck = await query(
        'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
        [req.session?.userId, user.id]
      );
      if (followCheck.rows.length === 0) {
        return res.status(403).json({ error: 'This account is private' });
      }
    }

    let queryText = `
      SELECT p.id, p.caption, p.like_count, p.comment_count, p.created_at,
             (SELECT media_url FROM post_media WHERE post_id = p.id ORDER BY order_index LIMIT 1) as thumbnail,
             (SELECT COUNT(*) FROM post_media WHERE post_id = p.id) as media_count
      FROM posts p
      WHERE p.user_id = $1
    `;
    const params = [user.id];

    if (cursor) {
      queryText += ` AND p.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) + 1);

    const result = await query(queryText, params);

    const hasMore = result.rows.length > limit;
    const posts = result.rows.slice(0, limit);

    res.json({
      posts: posts.map((p) => ({
        id: p.id,
        thumbnail: p.thumbnail,
        likeCount: p.like_count,
        commentCount: p.comment_count,
        mediaCount: parseInt(p.media_count),
        createdAt: p.created_at,
      })),
      nextCursor: hasMore ? posts[posts.length - 1].created_at : null,
    });
  } catch (error) {
    logger.error({
      type: 'get_user_posts_error',
      error: error.message,
      username: req.params.username,
    }, `Get user posts error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's saved posts
router.get('/me/saved', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { cursor, limit = 12 } = req.query;

    let queryText = `
      SELECT p.id, p.caption, p.like_count, p.comment_count, p.created_at, sp.created_at as saved_at,
             (SELECT media_url FROM post_media WHERE post_id = p.id ORDER BY order_index LIMIT 1) as thumbnail,
             (SELECT COUNT(*) FROM post_media WHERE post_id = p.id) as media_count
      FROM saved_posts sp
      JOIN posts p ON sp.post_id = p.id
      WHERE sp.user_id = $1
    `;
    const params = [userId];

    if (cursor) {
      queryText += ` AND sp.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY sp.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) + 1);

    const result = await query(queryText, params);

    const hasMore = result.rows.length > limit;
    const posts = result.rows.slice(0, limit);

    res.json({
      posts: posts.map((p) => ({
        id: p.id,
        thumbnail: p.thumbnail,
        likeCount: p.like_count,
        commentCount: p.comment_count,
        mediaCount: parseInt(p.media_count),
        savedAt: p.saved_at,
      })),
      nextCursor: hasMore ? posts[posts.length - 1].saved_at : null,
    });
  } catch (error) {
    logger.error({
      type: 'get_saved_posts_error',
      error: error.message,
      userId: req.session.userId,
    }, `Get saved posts error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Follow user - with rate limiting
 *
 * WHY RATE LIMITING PREVENTS FOLLOW SPAM:
 *
 * Follow spam is a common engagement manipulation technique where users:
 * - Rapidly follow hundreds of accounts to get follow-backs
 * - Use bots to automate mass following
 * - Unfollow after getting follow-backs to inflate follower ratio
 *
 * Without rate limiting:
 * - Bots can follow 1000+ users per hour
 * - Creates notification spam for victims
 * - Inflates social graphs with fake relationships
 * - Degrades platform trust and authenticity
 *
 * With rate limiting (30 follows/hour):
 * - Normal users rarely hit the limit
 * - Bots become economically unviable
 * - Real relationships are prioritized
 * - Notification quality remains high
 *
 * Rate limit is per-user using Redis sliding window:
 * - Key: ratelimit:follows:{userId}
 * - Window: 1 hour
 * - Limit: 30 follows
 * - Distributed across all API servers
 */
router.post('/:userId/follow', requireAuth, followRateLimitMiddleware, async (req, res) => {
  try {
    const { userId: targetUserId } = req.params;
    const currentUserId = req.session.userId;

    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    // Check if target user exists
    const userCheck = await query('SELECT id, username FROM users WHERE id = $1', [targetUserId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Insert follow - idempotent with ON CONFLICT
    const result = await query(
      'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
      [currentUserId, targetUserId]
    );

    if (result.rows.length === 0) {
      // Already following - idempotent response
      return res.json({ message: 'Already following user', idempotent: true });
    }

    // Track metrics
    followsTotal.labels('follow').inc();

    logger.info({
      type: 'follow',
      followerId: currentUserId,
      followingId: targetUserId,
      targetUsername: userCheck.rows[0].username,
    }, `User ${currentUserId} followed ${targetUserId}`);

    // Add target user's recent posts to follower's timeline
    const recentPosts = await query(
      `SELECT id, created_at FROM posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [targetUserId]
    );

    for (const post of recentPosts.rows) {
      await timelineAdd(currentUserId, post.id, new Date(post.created_at).getTime());
    }

    res.json({ message: 'User followed', idempotent: false });
  } catch (error) {
    logger.error({
      type: 'follow_error',
      error: error.message,
      targetUserId: req.params.userId,
    }, `Follow user error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unfollow user
router.delete('/:userId/follow', requireAuth, async (req, res) => {
  try {
    const { userId: targetUserId } = req.params;
    const currentUserId = req.session.userId;

    const result = await query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING id',
      [currentUserId, targetUserId]
    );

    if (result.rows.length === 0) {
      // Already not following - idempotent response
      return res.json({ message: 'Was not following user', idempotent: true });
    }

    // Track metrics
    followsTotal.labels('unfollow').inc();

    logger.info({
      type: 'unfollow',
      followerId: currentUserId,
      followingId: targetUserId,
    }, `User ${currentUserId} unfollowed ${targetUserId}`);

    res.json({ message: 'User unfollowed', idempotent: false });
  } catch (error) {
    logger.error({
      type: 'unfollow_error',
      error: error.message,
      targetUserId: req.params.userId,
    }, `Unfollow user error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user followers
router.get('/:username/followers', async (req, res) => {
  try {
    const { username } = req.params;
    const { cursor, limit = 20 } = req.query;

    const userResult = await query('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = userResult.rows[0].id;

    let queryText = `
      SELECT u.id, u.username, u.display_name, u.profile_picture_url, f.created_at
      FROM follows f
      JOIN users u ON f.follower_id = u.id
      WHERE f.following_id = $1
    `;
    const params = [userId];

    if (cursor) {
      queryText += ` AND f.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY f.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) + 1);

    const result = await query(queryText, params);

    const hasMore = result.rows.length > limit;
    const followers = result.rows.slice(0, limit);

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
    logger.error({
      type: 'get_followers_error',
      error: error.message,
      username: req.params.username,
    }, `Get followers error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user following
router.get('/:username/following', async (req, res) => {
  try {
    const { username } = req.params;
    const { cursor, limit = 20 } = req.query;

    const userResult = await query('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = userResult.rows[0].id;

    let queryText = `
      SELECT u.id, u.username, u.display_name, u.profile_picture_url, f.created_at
      FROM follows f
      JOIN users u ON f.following_id = u.id
      WHERE f.follower_id = $1
    `;
    const params = [userId];

    if (cursor) {
      queryText += ` AND f.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY f.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) + 1);

    const result = await query(queryText, params);

    const hasMore = result.rows.length > limit;
    const following = result.rows.slice(0, limit);

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
    logger.error({
      type: 'get_following_error',
      error: error.message,
      username: req.params.username,
    }, `Get following error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search users
router.get('/search/users', async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;

    if (!q || q.length < 2) {
      return res.json({ users: [] });
    }

    const result = await query(
      `SELECT id, username, display_name, profile_picture_url
       FROM users
       WHERE username ILIKE $1 OR display_name ILIKE $1
       ORDER BY follower_count DESC
       LIMIT $2`,
      [`%${q}%`, parseInt(limit)]
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
    logger.error({
      type: 'search_users_error',
      error: error.message,
    }, `Search users error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
