import { Router } from 'express';
import { query } from '../utils/db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Get user profile
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT u.id, u.username, u.profile_photo, u.bio, u.location, u.created_at,
              (SELECT COUNT(*) FROM activities WHERE user_id = u.id) as activity_count,
              (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as follower_count,
              (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count
       FROM users u WHERE u.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Check if current user follows this user
    let isFollowing = false;
    if (req.session.userId && req.session.userId !== id) {
      const followResult = await query(
        'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
        [req.session.userId, id]
      );
      isFollowing = followResult.rows.length > 0;
    }

    res.json({
      ...user,
      isFollowing,
      isOwnProfile: req.session.userId === id
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Update user profile
router.put('/me', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { username, bio, location, weightKg, profilePhoto } = req.body;

    const result = await query(
      `UPDATE users
       SET username = COALESCE($1, username),
           bio = COALESCE($2, bio),
           location = COALESCE($3, location),
           weight_kg = COALESCE($4, weight_kg),
           profile_photo = COALESCE($5, profile_photo),
           updated_at = NOW()
       WHERE id = $6
       RETURNING id, username, email, profile_photo, bio, location, weight_kg, role`,
      [username, bio, location, weightKg, profilePhoto, userId]
    );

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Follow a user
router.post('/:id/follow', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const followerId = req.session.userId;

    if (followerId === id) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    await query(
      'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [followerId, id]
    );

    res.json({ message: 'Following user' });
  } catch (error) {
    console.error('Follow error:', error);
    res.status(500).json({ error: 'Failed to follow user' });
  }
});

// Unfollow a user
router.delete('/:id/follow', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const followerId = req.session.userId;

    await query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
      [followerId, id]
    );

    res.json({ message: 'Unfollowed user' });
  } catch (error) {
    console.error('Unfollow error:', error);
    res.status(500).json({ error: 'Failed to unfollow user' });
  }
});

// Get user's followers
router.get('/:id/followers', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    const result = await query(
      `SELECT u.id, u.username, u.profile_photo, f.created_at as followed_at
       FROM follows f
       JOIN users u ON f.follower_id = u.id
       WHERE f.following_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    res.json({ followers: result.rows });
  } catch (error) {
    console.error('Get followers error:', error);
    res.status(500).json({ error: 'Failed to get followers' });
  }
});

// Get users that user is following
router.get('/:id/following', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    const result = await query(
      `SELECT u.id, u.username, u.profile_photo, f.created_at as followed_at
       FROM follows f
       JOIN users u ON f.following_id = u.id
       WHERE f.follower_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    res.json({ following: result.rows });
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ error: 'Failed to get following' });
  }
});

// Get user's achievements
router.get('/:id/achievements', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT a.id, a.name, a.description, a.icon, ua.earned_at
       FROM user_achievements ua
       JOIN achievements a ON ua.achievement_id = a.id
       WHERE ua.user_id = $1
       ORDER BY ua.earned_at DESC`,
      [id]
    );

    res.json({ achievements: result.rows });
  } catch (error) {
    console.error('Get achievements error:', error);
    res.status(500).json({ error: 'Failed to get achievements' });
  }
});

// Search users
router.get('/', async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;

    if (!q || q.length < 2) {
      return res.json({ users: [] });
    }

    const result = await query(
      `SELECT id, username, profile_photo, bio
       FROM users
       WHERE username ILIKE $1 OR bio ILIKE $1
       LIMIT $2`,
      [`%${q}%`, limit]
    );

    res.json({ users: result.rows });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

export default router;
