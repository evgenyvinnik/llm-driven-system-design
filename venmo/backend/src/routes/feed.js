const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Get user's social feed (pre-computed via fan-out)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { limit = 20, before } = req.query;

    let query = `
      SELECT DISTINCT ON (t.id)
             t.*,
             sender.username as sender_username,
             sender.name as sender_name,
             sender.avatar_url as sender_avatar,
             receiver.username as receiver_username,
             receiver.name as receiver_name,
             receiver.avatar_url as receiver_avatar,
             (SELECT COUNT(*) FROM transfer_likes WHERE transfer_id = t.id) as likes_count,
             (SELECT COUNT(*) FROM transfer_comments WHERE transfer_id = t.id) as comments_count,
             EXISTS(SELECT 1 FROM transfer_likes WHERE user_id = $1 AND transfer_id = t.id) as user_liked
      FROM feed_items f
      JOIN transfers t ON f.transfer_id = t.id
      JOIN users sender ON t.sender_id = sender.id
      JOIN users receiver ON t.receiver_id = receiver.id
      WHERE f.user_id = $1
    `;

    const params = [req.user.id];
    let paramIndex = 2;

    if (before) {
      query += ` AND t.created_at < $${paramIndex}`;
      params.push(before);
      paramIndex++;
    }

    query += ` ORDER BY t.id, t.created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));

    // Final ordering after DISTINCT
    const result = await pool.query(
      `SELECT * FROM (${query}) sub ORDER BY created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Get global/public feed (all public transactions)
router.get('/global', authMiddleware, async (req, res) => {
  try {
    const { limit = 20, before } = req.query;

    let query = `
      SELECT t.*,
             sender.username as sender_username,
             sender.name as sender_name,
             sender.avatar_url as sender_avatar,
             receiver.username as receiver_username,
             receiver.name as receiver_name,
             receiver.avatar_url as receiver_avatar,
             (SELECT COUNT(*) FROM transfer_likes WHERE transfer_id = t.id) as likes_count,
             (SELECT COUNT(*) FROM transfer_comments WHERE transfer_id = t.id) as comments_count,
             EXISTS(SELECT 1 FROM transfer_likes WHERE user_id = $1 AND transfer_id = t.id) as user_liked
      FROM transfers t
      JOIN users sender ON t.sender_id = sender.id
      JOIN users receiver ON t.receiver_id = receiver.id
      WHERE t.visibility = 'public'
    `;

    const params = [req.user.id];
    let paramIndex = 2;

    if (before) {
      query += ` AND t.created_at < $${paramIndex}`;
      params.push(before);
      paramIndex++;
    }

    query += ` ORDER BY t.created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get global feed error:', error);
    res.status(500).json({ error: 'Failed to get global feed' });
  }
});

// Get user's own transaction history for their profile
router.get('/user/:username', authMiddleware, async (req, res) => {
  try {
    const { limit = 20, before } = req.query;
    const { username } = req.params;

    // Get user ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUserId = userResult.rows[0].id;
    const isOwnProfile = targetUserId === req.user.id;

    // Check if friends
    const friendResult = await pool.query(
      `SELECT 1 FROM friendships
       WHERE user_id = $1 AND friend_id = $2 AND status = 'accepted'`,
      [req.user.id, targetUserId]
    );
    const isFriend = friendResult.rows.length > 0;

    let query = `
      SELECT t.*,
             sender.username as sender_username,
             sender.name as sender_name,
             sender.avatar_url as sender_avatar,
             receiver.username as receiver_username,
             receiver.name as receiver_name,
             receiver.avatar_url as receiver_avatar,
             (SELECT COUNT(*) FROM transfer_likes WHERE transfer_id = t.id) as likes_count,
             (SELECT COUNT(*) FROM transfer_comments WHERE transfer_id = t.id) as comments_count,
             EXISTS(SELECT 1 FROM transfer_likes WHERE user_id = $1 AND transfer_id = t.id) as user_liked
      FROM transfers t
      JOIN users sender ON t.sender_id = sender.id
      JOIN users receiver ON t.receiver_id = receiver.id
      WHERE (t.sender_id = $2 OR t.receiver_id = $2)
    `;

    const params = [req.user.id, targetUserId];
    let paramIndex = 3;

    // Apply visibility filter if not own profile
    if (!isOwnProfile) {
      if (isFriend) {
        query += ` AND t.visibility IN ('public', 'friends')`;
      } else {
        query += ` AND t.visibility = 'public'`;
      }
    }

    if (before) {
      query += ` AND t.created_at < $${paramIndex}`;
      params.push(before);
      paramIndex++;
    }

    query += ` ORDER BY t.created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get user feed error:', error);
    res.status(500).json({ error: 'Failed to get user feed' });
  }
});

module.exports = router;
