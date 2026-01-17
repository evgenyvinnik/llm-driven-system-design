import express from 'express';
import pool from '../db/pool.js';
import redis from '../db/redis.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /api/users/:username - Get user profile
router.get('/:username', async (req, res, next) => {
  try {
    const { username } = req.params;

    const result = await pool.query(
      `SELECT id, username, display_name, bio, avatar_url,
              follower_count, following_count, tweet_count, is_celebrity, created_at
       FROM users WHERE username = $1`,
      [username.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    let isFollowing = false;

    // Check if current user is following this user
    if (req.session && req.session.userId && req.session.userId !== user.id) {
      const followCheck = await pool.query(
        'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
        [req.session.userId, user.id]
      );
      isFollowing = followCheck.rows.length > 0;
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        bio: user.bio,
        avatarUrl: user.avatar_url,
        followerCount: user.follower_count,
        followingCount: user.following_count,
        tweetCount: user.tweet_count,
        isCelebrity: user.is_celebrity,
        createdAt: user.created_at,
        isFollowing,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/users/:id/follow - Follow a user
router.post('/:id/follow', requireAuth, async (req, res, next) => {
  try {
    const followingId = parseInt(req.params.id);
    const followerId = req.session.userId;

    if (followingId === followerId) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    // Check if user exists
    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [followingId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if already following
    const existingFollow = await pool.query(
      'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
      [followerId, followingId]
    );

    if (existingFollow.rows.length > 0) {
      return res.status(409).json({ error: 'Already following this user' });
    }

    // Create follow relationship
    await pool.query(
      'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)',
      [followerId, followingId]
    );

    // Update Redis cache for social graph
    await redis.sadd(`following:${followerId}`, followingId.toString());
    await redis.sadd(`followers:${followingId}`, followerId.toString());

    res.status(201).json({ message: 'Successfully followed user' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/users/:id/follow - Unfollow a user
router.delete('/:id/follow', requireAuth, async (req, res, next) => {
  try {
    const followingId = parseInt(req.params.id);
    const followerId = req.session.userId;

    // Delete follow relationship
    const result = await pool.query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING *',
      [followerId, followingId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Not following this user' });
    }

    // Update Redis cache
    await redis.srem(`following:${followerId}`, followingId.toString());
    await redis.srem(`followers:${followingId}`, followerId.toString());

    res.json({ message: 'Successfully unfollowed user' });
  } catch (error) {
    next(error);
  }
});

// GET /api/users/:id/followers - Get user's followers
router.get('/:id/followers', async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_url,
              u.follower_count, u.following_count
       FROM users u
       JOIN follows f ON f.follower_id = u.id
       WHERE f.following_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    // Get follow status for each user if logged in
    let followStatus = {};
    if (req.session && req.session.userId) {
      const followingIds = result.rows.map(u => u.id);
      if (followingIds.length > 0) {
        const followCheck = await pool.query(
          'SELECT following_id FROM follows WHERE follower_id = $1 AND following_id = ANY($2)',
          [req.session.userId, followingIds]
        );
        followCheck.rows.forEach(row => {
          followStatus[row.following_id] = true;
        });
      }
    }

    res.json({
      users: result.rows.map(user => ({
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        bio: user.bio,
        avatarUrl: user.avatar_url,
        followerCount: user.follower_count,
        followingCount: user.following_count,
        isFollowing: followStatus[user.id] || false,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/users/:id/following - Get users that a user follows
router.get('/:id/following', async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_url,
              u.follower_count, u.following_count
       FROM users u
       JOIN follows f ON f.following_id = u.id
       WHERE f.follower_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    // Get follow status for each user if logged in
    let followStatus = {};
    if (req.session && req.session.userId) {
      const followingIds = result.rows.map(u => u.id);
      if (followingIds.length > 0) {
        const followCheck = await pool.query(
          'SELECT following_id FROM follows WHERE follower_id = $1 AND following_id = ANY($2)',
          [req.session.userId, followingIds]
        );
        followCheck.rows.forEach(row => {
          followStatus[row.following_id] = true;
        });
      }
    }

    res.json({
      users: result.rows.map(user => ({
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        bio: user.bio,
        avatarUrl: user.avatar_url,
        followerCount: user.follower_count,
        followingCount: user.following_count,
        isFollowing: followStatus[user.id] || false,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/users/search - Search users
router.get('/', async (req, res, next) => {
  try {
    const query = req.query.q;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const result = await pool.query(
      `SELECT id, username, display_name, bio, avatar_url,
              follower_count, following_count
       FROM users
       WHERE username ILIKE $1 OR display_name ILIKE $1
       ORDER BY follower_count DESC
       LIMIT $2`,
      [`%${query}%`, limit]
    );

    res.json({
      users: result.rows.map(user => ({
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        bio: user.bio,
        avatarUrl: user.avatar_url,
        followerCount: user.follower_count,
        followingCount: user.following_count,
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
