import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../utils/db.js';
import { cacheUser } from '../utils/redis.js';

const router = Router();

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, weightKg, bio, location } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    // Check if user exists
    const existing = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await query(
      `INSERT INTO users (username, email, password_hash, weight_kg, bio, location)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, email, weight_kg, bio, location, role, created_at`,
      [username, email, passwordHash, weightKg || null, bio || null, location || null]
    );

    const user = result.rows[0];

    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    // Cache user
    await cacheUser(user.id, user);

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        weightKg: user.weight_kg,
        bio: user.bio,
        location: user.location,
        role: user.role
      }
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

    const result = await query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    // Cache user
    await cacheUser(user.id, user);

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        weightKg: user.weight_kg,
        bio: user.bio,
        location: user.location,
        role: user.role,
        profilePhoto: user.profile_photo
      }
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
router.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  res.json({
    user: {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role
    }
  });
});

export default router;
