const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Get friends list
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.name, u.avatar_url, f.created_at as friends_since
       FROM friendships f
       JOIN users u ON f.friend_id = u.id
       WHERE f.user_id = $1 AND f.status = 'accepted'
       ORDER BY u.name`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get friends error:', error);
    res.status(500).json({ error: 'Failed to get friends' });
  }
});

// Get pending friend requests (received)
router.get('/requests', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.name, u.avatar_url, f.created_at as requested_at
       FROM friendships f
       JOIN users u ON f.user_id = u.id
       WHERE f.friend_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get friend requests error:', error);
    res.status(500).json({ error: 'Failed to get friend requests' });
  }
});

// Get sent friend requests
router.get('/sent', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.name, u.avatar_url, f.created_at as sent_at
       FROM friendships f
       JOIN users u ON f.friend_id = u.id
       WHERE f.user_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get sent requests error:', error);
    res.status(500).json({ error: 'Failed to get sent requests' });
  }
});

// Send friend request
router.post('/request/:username', authMiddleware, async (req, res) => {
  try {
    const { username } = req.params;

    // Get target user
    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const friendId = userResult.rows[0].id;

    if (friendId === req.user.id) {
      return res.status(400).json({ error: 'Cannot add yourself as friend' });
    }

    // Check if already friends or request exists
    const existingResult = await pool.query(
      'SELECT status FROM friendships WHERE user_id = $1 AND friend_id = $2',
      [req.user.id, friendId]
    );

    if (existingResult.rows.length > 0) {
      const status = existingResult.rows[0].status;
      if (status === 'accepted') {
        return res.status(400).json({ error: 'Already friends' });
      }
      return res.status(400).json({ error: 'Friend request already sent' });
    }

    // Check if they already sent us a request - if so, accept it
    const reverseResult = await pool.query(
      'SELECT status FROM friendships WHERE user_id = $1 AND friend_id = $2',
      [friendId, req.user.id]
    );

    if (reverseResult.rows.length > 0 && reverseResult.rows[0].status === 'pending') {
      // Accept their request
      await pool.query(
        `UPDATE friendships SET status = 'accepted' WHERE user_id = $1 AND friend_id = $2`,
        [friendId, req.user.id]
      );
      await pool.query(
        `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'accepted')`,
        [req.user.id, friendId]
      );
      return res.json({ message: 'Friend request accepted' });
    }

    // Send new request
    await pool.query(
      `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'pending')`,
      [req.user.id, friendId]
    );

    res.status(201).json({ message: 'Friend request sent' });
  } catch (error) {
    console.error('Send friend request error:', error);
    res.status(500).json({ error: 'Failed to send friend request' });
  }
});

// Accept friend request
router.post('/accept/:username', authMiddleware, async (req, res) => {
  try {
    const { username } = req.params;

    // Get requesting user
    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const requesterId = userResult.rows[0].id;

    // Update their request to accepted
    const updateResult = await pool.query(
      `UPDATE friendships SET status = 'accepted' WHERE user_id = $1 AND friend_id = $2 AND status = 'pending' RETURNING *`,
      [requesterId, req.user.id]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Friend request not found' });
    }

    // Add reverse friendship
    await pool.query(
      `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'accepted') ON CONFLICT DO NOTHING`,
      [req.user.id, requesterId]
    );

    res.json({ message: 'Friend request accepted' });
  } catch (error) {
    console.error('Accept friend request error:', error);
    res.status(500).json({ error: 'Failed to accept friend request' });
  }
});

// Decline friend request
router.post('/decline/:username', authMiddleware, async (req, res) => {
  try {
    const { username } = req.params;

    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const requesterId = userResult.rows[0].id;

    await pool.query(
      'DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2 AND status = $3',
      [requesterId, req.user.id, 'pending']
    );

    res.json({ message: 'Friend request declined' });
  } catch (error) {
    console.error('Decline friend request error:', error);
    res.status(500).json({ error: 'Failed to decline friend request' });
  }
});

// Remove friend
router.delete('/:username', authMiddleware, async (req, res) => {
  try {
    const { username } = req.params;

    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const friendId = userResult.rows[0].id;

    // Remove both directions
    await pool.query(
      'DELETE FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [req.user.id, friendId]
    );

    res.json({ message: 'Friend removed' });
  } catch (error) {
    console.error('Remove friend error:', error);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

module.exports = router;
