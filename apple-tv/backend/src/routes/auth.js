const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    // Check if user exists
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    await db.query(`
      INSERT INTO users (id, email, password_hash, name, role, subscription_tier)
      VALUES ($1, $2, $3, $4, 'user', 'free')
    `, [userId, email, passwordHash, name]);

    // Create default profile
    const profileId = uuidv4();
    await db.query(`
      INSERT INTO user_profiles (id, user_id, name, is_kids)
      VALUES ($1, $2, $3, false)
    `, [profileId, userId, name]);

    res.status(201).json({ message: 'User registered successfully' });
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

    const result = await db.query(`
      SELECT id, email, password_hash, name, role, subscription_tier, subscription_expires_at
      FROM users WHERE email = $1
    `, [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Set session
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.name = user.name;
    req.session.role = user.role;
    req.session.subscriptionTier = user.subscription_tier;
    req.session.subscriptionExpiresAt = user.subscription_expires_at;

    // Get profiles
    const profiles = await db.query(`
      SELECT id, name, avatar_url, is_kids FROM user_profiles WHERE user_id = $1
    `, [user.id]);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        subscriptionTier: user.subscription_tier,
        subscriptionExpiresAt: user.subscription_expires_at
      },
      profiles: profiles.rows
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
    res.clearCookie('appletv.sid');
    res.json({ message: 'Logged out successfully' });
  });
});

// Get current user
router.get('/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const profiles = await db.query(`
      SELECT id, name, avatar_url, is_kids FROM user_profiles WHERE user_id = $1
    `, [req.session.userId]);

    res.json({
      user: {
        id: req.session.userId,
        email: req.session.email,
        name: req.session.name,
        role: req.session.role,
        subscriptionTier: req.session.subscriptionTier,
        subscriptionExpiresAt: req.session.subscriptionExpiresAt
      },
      profiles: profiles.rows
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Select profile
router.post('/profile/:profileId/select', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const { profileId } = req.params;

    const result = await db.query(`
      SELECT id, name, avatar_url, is_kids FROM user_profiles
      WHERE id = $1 AND user_id = $2
    `, [profileId, req.session.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    req.session.profileId = result.rows[0].id;
    req.session.profileName = result.rows[0].name;
    req.session.isKids = result.rows[0].is_kids;

    res.json({ profile: result.rows[0] });
  } catch (error) {
    console.error('Select profile error:', error);
    res.status(500).json({ error: 'Failed to select profile' });
  }
});

// Create profile
router.post('/profiles', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const { name, isKids } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Profile name is required' });
    }

    // Check profile limit (max 6 profiles)
    const count = await db.query(`
      SELECT COUNT(*) FROM user_profiles WHERE user_id = $1
    `, [req.session.userId]);

    if (parseInt(count.rows[0].count) >= 6) {
      return res.status(400).json({ error: 'Maximum profiles reached (6)' });
    }

    const profileId = uuidv4();
    await db.query(`
      INSERT INTO user_profiles (id, user_id, name, is_kids)
      VALUES ($1, $2, $3, $4)
    `, [profileId, req.session.userId, name, isKids || false]);

    res.status(201).json({
      id: profileId,
      name,
      isKids: isKids || false
    });
  } catch (error) {
    console.error('Create profile error:', error);
    res.status(500).json({ error: 'Failed to create profile' });
  }
});

// Delete profile
router.delete('/profiles/:profileId', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const { profileId } = req.params;

    // Check ownership and ensure not the only profile
    const profiles = await db.query(`
      SELECT id FROM user_profiles WHERE user_id = $1
    `, [req.session.userId]);

    if (profiles.rows.length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the only profile' });
    }

    const result = await db.query(`
      DELETE FROM user_profiles WHERE id = $1 AND user_id = $2 RETURNING id
    `, [profileId, req.session.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Clear session profile if deleted
    if (req.session.profileId === profileId) {
      delete req.session.profileId;
      delete req.session.profileName;
      delete req.session.isKids;
    }

    res.json({ message: 'Profile deleted' });
  } catch (error) {
    console.error('Delete profile error:', error);
    res.status(500).json({ error: 'Failed to delete profile' });
  }
});

module.exports = router;
