import express from 'express';
import { query } from '../db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// Get user profile by username
router.get('/:username', optionalAuth, async (req, res) => {
  try {
    const { username } = req.params;

    const result = await query(
      `SELECT id, username, display_name, avatar_url, bio,
              follower_count, following_count, video_count, like_count, created_at
       FROM users WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Check if current user follows this user
    let isFollowing = false;
    if (req.session?.userId && req.session.userId !== user.id) {
      const followResult = await query(
        'SELECT id FROM follows WHERE follower_id = $1 AND following_id = $2',
        [req.session.userId, user.id]
      );
      isFollowing = followResult.rows.length > 0;
    }

    res.json({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      bio: user.bio,
      followerCount: user.follower_count,
      followingCount: user.following_count,
      videoCount: user.video_count,
      likeCount: user.like_count,
      createdAt: user.created_at,
      isFollowing,
      isOwnProfile: req.session?.userId === user.id,
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update current user profile
router.patch('/me', requireAuth, async (req, res) => {
  try {
    const { displayName, bio, avatarUrl } = req.body;
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
    if (avatarUrl !== undefined) {
      updates.push(`avatar_url = $${paramIndex++}`);
      values.push(avatarUrl);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.session.userId);

    const result = await query(
      `UPDATE users SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, username, email, display_name, avatar_url, bio,
                 follower_count, following_count, video_count, created_at`,
      values
    );

    const user = result.rows[0];

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      bio: user.bio,
      followerCount: user.follower_count,
      followingCount: user.following_count,
      videoCount: user.video_count,
      createdAt: user.created_at,
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Follow a user
router.post('/:username/follow', requireAuth, async (req, res) => {
  try {
    const { username } = req.params;

    // Get target user
    const userResult = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUserId = userResult.rows[0].id;

    if (targetUserId === req.session.userId) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    // Check if already following
    const existingFollow = await query(
      'SELECT id FROM follows WHERE follower_id = $1 AND following_id = $2',
      [req.session.userId, targetUserId]
    );

    if (existingFollow.rows.length > 0) {
      return res.status(409).json({ error: 'Already following' });
    }

    // Create follow
    await query(
      'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)',
      [req.session.userId, targetUserId]
    );

    // Update counts
    await query(
      'UPDATE users SET follower_count = follower_count + 1 WHERE id = $1',
      [targetUserId]
    );
    await query(
      'UPDATE users SET following_count = following_count + 1 WHERE id = $1',
      [req.session.userId]
    );

    res.json({ message: 'Followed successfully', isFollowing: true });
  } catch (error) {
    console.error('Follow error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unfollow a user
router.delete('/:username/follow', requireAuth, async (req, res) => {
  try {
    const { username } = req.params;

    // Get target user
    const userResult = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUserId = userResult.rows[0].id;

    // Delete follow
    const deleteResult = await query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING id',
      [req.session.userId, targetUserId]
    );

    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Not following this user' });
    }

    // Update counts
    await query(
      'UPDATE users SET follower_count = GREATEST(follower_count - 1, 0) WHERE id = $1',
      [targetUserId]
    );
    await query(
      'UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id = $1',
      [req.session.userId]
    );

    res.json({ message: 'Unfollowed successfully', isFollowing: false });
  } catch (error) {
    console.error('Unfollow error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's followers
router.get('/:username/followers', async (req, res) => {
  try {
    const { username } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const userResult = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.follower_count
       FROM follows f
       JOIN users u ON f.follower_id = u.id
       WHERE f.following_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userResult.rows[0].id, limit, offset]
    );

    res.json({
      followers: result.rows.map(user => ({
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        bio: user.bio,
        followerCount: user.follower_count,
      })),
      hasMore: result.rows.length === limit,
    });
  } catch (error) {
    console.error('Get followers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's following
router.get('/:username/following', async (req, res) => {
  try {
    const { username } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const userResult = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.follower_count
       FROM follows f
       JOIN users u ON f.following_id = u.id
       WHERE f.follower_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userResult.rows[0].id, limit, offset]
    );

    res.json({
      following: result.rows.map(user => ({
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        bio: user.bio,
        followerCount: user.follower_count,
      })),
      hasMore: result.rows.length === limit,
    });
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
