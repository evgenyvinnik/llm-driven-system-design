const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool, transaction } = require('../db/pool');
const { setSession, deleteSession } = require('../db/redis');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, name, phone } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    // Check if username or email already exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username.toLowerCase(), email.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username or email already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const avatarUrl = `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`;

    // Create user and wallet in transaction
    const user = await transaction(async (client) => {
      const userResult = await client.query(
        `INSERT INTO users (username, email, password_hash, name, phone, avatar_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, username, email, name, avatar_url, role`,
        [username.toLowerCase(), email.toLowerCase(), passwordHash, name, phone, avatarUrl]
      );

      // Create wallet with 0 balance
      await client.query(
        'INSERT INTO wallets (user_id, balance) VALUES ($1, 0)',
        [userResult.rows[0].id]
      );

      return userResult.rows[0];
    });

    // Create session
    const sessionId = uuidv4();
    await setSession(sessionId, user.id);

    res.status(201).json({ user, sessionId });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await pool.query(
      'SELECT id, username, email, name, avatar_url, password_hash, role FROM users WHERE username = $1 OR email = $1',
      [username.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create session
    const sessionId = uuidv4();
    await setSession(sessionId, user.id);

    // Remove password hash from response
    delete user.password_hash;

    res.json({ user, sessionId });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    await deleteSession(req.sessionId);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Get current user
router.get('/me', authMiddleware, async (req, res) => {
  try {
    // Get wallet balance
    const walletResult = await pool.query(
      'SELECT balance, pending_balance FROM wallets WHERE user_id = $1',
      [req.user.id]
    );

    const wallet = walletResult.rows[0] || { balance: 0, pending_balance: 0 };

    res.json({
      ...req.user,
      wallet: {
        balance: wallet.balance,
        pendingBalance: wallet.pending_balance,
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Update user profile
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const { name, phone, avatar_url } = req.body;

    const result = await pool.query(
      `UPDATE users SET name = COALESCE($1, name), phone = COALESCE($2, phone),
       avatar_url = COALESCE($3, avatar_url), updated_at = NOW()
       WHERE id = $4
       RETURNING id, username, email, name, phone, avatar_url, role`,
      [name, phone, avatar_url, req.user.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Search users
router.get('/search', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.json([]);
    }

    const result = await pool.query(
      `SELECT id, username, name, avatar_url FROM users
       WHERE id != $1 AND (username ILIKE $2 OR name ILIKE $2)
       LIMIT 10`,
      [req.user.id, `%${q}%`]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get user by username
router.get('/:username', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.name, u.avatar_url,
              (SELECT COUNT(*) FROM friendships WHERE user_id = u.id AND status = 'accepted') as friends_count,
              (SELECT COUNT(*) FROM transfers WHERE sender_id = u.id OR receiver_id = u.id) as transactions_count,
              EXISTS(SELECT 1 FROM friendships WHERE user_id = $2 AND friend_id = u.id AND status = 'accepted') as is_friend
       FROM users u WHERE u.username = $1`,
      [req.params.username.toLowerCase(), req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

module.exports = router;
