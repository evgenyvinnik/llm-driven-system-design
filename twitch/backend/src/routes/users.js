const express = require('express');
const { query } = require('../services/database');
const { getSession } = require('../services/redis');

const router = express.Router();

// Get user profile
router.get('/:username', async (req, res) => {
  try {
    const { username } = req.params;

    const result = await query(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.created_at,
             c.id as channel_id, c.follower_count, c.subscriber_count, c.is_live
      FROM users u
      LEFT JOIN channels c ON c.user_id = u.id
      WHERE u.username = $1
    `, [username]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const row = result.rows[0];
    res.json({
      user: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        bio: row.bio,
        createdAt: row.created_at,
        channel: row.channel_id ? {
          id: row.channel_id,
          followerCount: row.follower_count,
          subscriberCount: row.subscriber_count,
          isLive: row.is_live
        } : null
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Get user's followed channels
router.get('/:username/following', async (req, res) => {
  try {
    const { username } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    const userResult = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = userResult.rows[0].id;

    const result = await query(`
      SELECT c.id, c.name, c.title, c.is_live, c.current_viewers,
             c.thumbnail_url, f.followed_at,
             u.username, u.display_name, u.avatar_url,
             cat.name as category_name, cat.slug as category_slug
      FROM followers f
      JOIN channels c ON f.channel_id = c.id
      JOIN users u ON c.user_id = u.id
      LEFT JOIN categories cat ON c.category_id = cat.id
      WHERE f.user_id = $1
      ORDER BY c.is_live DESC, f.followed_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, parseInt(limit), parseInt(offset)]);

    res.json({
      following: result.rows.map(row => ({
        id: row.id,
        name: row.name,
        title: row.title,
        isLive: row.is_live,
        viewerCount: row.current_viewers,
        thumbnailUrl: row.thumbnail_url,
        followedAt: row.followed_at,
        user: {
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url
        },
        category: row.category_name ? {
          name: row.category_name,
          slug: row.category_slug
        } : null
      }))
    });
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ error: 'Failed to get following' });
  }
});

// Update user profile
router.patch('/me', async (req, res) => {
  try {
    const sessionId = req.cookies.session;
    if (!sessionId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = await getSession(sessionId);
    if (!userId) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { displayName, bio, avatarUrl } = req.body;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (displayName !== undefined) {
      params.push(displayName);
      updates.push(`display_name = $${paramIndex++}`);
    }

    if (bio !== undefined) {
      params.push(bio);
      updates.push(`bio = $${paramIndex++}`);
    }

    if (avatarUrl !== undefined) {
      params.push(avatarUrl);
      updates.push(`avatar_url = $${paramIndex++}`);
    }

    if (updates.length === 0) {
      return res.json({ success: true, message: 'Nothing to update' });
    }

    params.push(userId);
    await query(`
      UPDATE users
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${paramIndex}
    `, params);

    res.json({ success: true });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

module.exports = router;
