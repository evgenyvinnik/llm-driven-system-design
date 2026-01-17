import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db/index.js';

const router = Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password, username, fullName } = req.body;

    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, password, and username are required' });
    }

    // Check if email or username exists
    const existing = await db.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email or username already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (email, password_hash, username, full_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, username, full_name, role, created_at`,
      [email, passwordHash, username, fullName || null]
    );

    const user = result.rows[0];

    // Get user's shops
    const shopsResult = await db.query('SELECT id FROM shops WHERE owner_id = $1', [user.id]);
    const shopIds = shopsResult.rows.map((s) => s.id);

    // Set session
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.shopIds = shopIds;

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
        shopIds,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await db.query(
      'SELECT id, email, password_hash, username, full_name, role, avatar_url FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Get user's shops
    const shopsResult = await db.query('SELECT id FROM shops WHERE owner_id = $1', [user.id]);
    const shopIds = shopsResult.rows.map((s) => s.id);

    // Set session
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.shopIds = shopIds;

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
        avatarUrl: user.avatar_url,
        shopIds,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out successfully' });
  });
});

// Get current user
router.get('/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const result = await db.query(
      'SELECT id, email, username, full_name, role, avatar_url FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      req.session.destroy();
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Get user's shops
    const shopsResult = await db.query('SELECT id, name, slug FROM shops WHERE owner_id = $1', [user.id]);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
        avatarUrl: user.avatar_url,
        shops: shopsResult.rows,
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

export default router;
