const express = require('express');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../services/database');
const { setSession, getSession, deleteSession } = require('../services/redis');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, displayName } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email and password are required' });
    }

    // Check if user exists
    const existing = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await query(`
      INSERT INTO users (username, email, password_hash, display_name)
      VALUES ($1, $2, $3, $4)
      RETURNING id, username, email, display_name, role, created_at
    `, [username, email, passwordHash, displayName || username]);

    const user = result.rows[0];

    // Generate stream key and create channel
    const streamKey = `sk_${username}_${uuidv4().slice(0, 8)}`;
    await query(`
      INSERT INTO channels (user_id, name, stream_key)
      VALUES ($1, $2, $3)
    `, [user.id, username, streamKey]);

    // Create session
    const sessionId = uuidv4();
    await setSession(sessionId, user.id);

    res.cookie('session', sessionId, {
      httpOnly: true,
      maxAge: 86400 * 1000,
      sameSite: 'lax'
    });

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await query(`
      SELECT id, username, email, password_hash, display_name, avatar_url, role
      FROM users WHERE username = $1
    `, [username]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create session
    const sessionId = uuidv4();
    await setSession(sessionId, user.id);

    res.cookie('session', sessionId, {
      httpOnly: true,
      maxAge: 86400 * 1000,
      sameSite: 'lax'
    });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Logout
router.post('/logout', async (req, res) => {
  try {
    const sessionId = req.cookies.session;
    if (sessionId) {
      await deleteSession(sessionId);
    }
    res.clearCookie('session');
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

// Get current user
router.get('/me', async (req, res) => {
  try {
    const sessionId = req.cookies.session;
    if (!sessionId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = await getSession(sessionId);
    if (!userId) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Session expired' });
    }

    const result = await query(`
      SELECT u.id, u.username, u.email, u.display_name, u.avatar_url, u.role,
             c.id as channel_id, c.stream_key, c.is_live
      FROM users u
      LEFT JOIN channels c ON c.user_id = u.id
      WHERE u.id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        role: user.role,
        channel: {
          id: user.channel_id,
          streamKey: user.stream_key,
          isLive: user.is_live
        }
      }
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

module.exports = router;
