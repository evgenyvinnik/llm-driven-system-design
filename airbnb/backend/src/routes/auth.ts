import { Router } from 'express';
import { query } from '../db.js';
import { createSession, deleteSession, hashPassword, verifyPassword } from '../services/auth.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Register
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name are required' });
  }

  try {
    // Check if user exists
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await hashPassword(password);

    const result = await query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, is_host, role',
      [email, passwordHash, name]
    );

    const user = result.rows[0];
    const { sessionId, expiresAt } = await createSession(user.id);

    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
    });

    res.status(201).json({ user });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await query(
      'SELECT id, email, name, password_hash, is_host, is_verified, role, avatar_url FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await verifyPassword(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const { sessionId, expiresAt } = await createSession(user.id);

    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
    });

    const { password_hash, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
router.post('/logout', authenticate, async (req, res) => {
  const sessionId = req.cookies?.session;

  if (sessionId) {
    await deleteSession(sessionId);
    res.clearCookie('session');
  }

  res.json({ message: 'Logged out' });
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user });
});

// Become a host
router.post('/become-host', authenticate, async (req, res) => {
  try {
    await query('UPDATE users SET is_host = TRUE WHERE id = $1', [req.user.id]);
    res.json({ message: 'You are now a host', is_host: true });
  } catch (error) {
    console.error('Become host error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Update profile
router.put('/profile', authenticate, async (req, res) => {
  const { name, bio, phone, avatar_url } = req.body;

  try {
    const result = await query(
      `UPDATE users SET
        name = COALESCE($1, name),
        bio = COALESCE($2, bio),
        phone = COALESCE($3, phone),
        avatar_url = COALESCE($4, avatar_url)
      WHERE id = $5
      RETURNING id, email, name, bio, phone, avatar_url, is_host, is_verified, role`,
      [name, bio, phone, avatar_url, req.user.id]
    );

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

export default router;
