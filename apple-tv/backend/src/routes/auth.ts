import express, { Request, Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db/index.js';

/** Authentication routes for registration, login, logout, profile selection, and profile CRUD. */
const router: Router = express.Router();

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  subscription_tier: string;
  subscription_expires_at: Date | null;
}

interface ProfileRow {
  id: string;
  name: string;
  avatar_url: string | null;
  is_kids: boolean;
}

// Register
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, name } = req.body as { email?: string; password?: string; name?: string };

    if (!email || !password || !name) {
      res.status(400).json({ error: 'Email, password, and name are required' });
      return;
    }

    // Check if user exists
    const existing = await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      res.status(400).json({ error: 'Email already registered' });
      return;
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
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const result = await db.query<UserRow>(`
      SELECT id, email, password_hash, name, role, subscription_tier, subscription_expires_at
      FROM users WHERE email = $1
    `, [email]);

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Set session
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.name = user.name;
    req.session.role = user.role;
    req.session.subscriptionTier = user.subscription_tier;
    req.session.subscriptionExpiresAt = user.subscription_expires_at || undefined;

    // Get profiles
    const profiles = await db.query<ProfileRow>(`
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
router.post('/logout', (req: Request, res: Response): void => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: 'Logout failed' });
      return;
    }
    res.clearCookie('appletv.sid');
    res.json({ message: 'Logged out successfully' });
  });
});

// Get current user
router.get('/me', async (req: Request, res: Response): Promise<void> => {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const profiles = await db.query<ProfileRow>(`
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
router.post('/profile/:profileId/select', async (req: Request, res: Response): Promise<void> => {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const { profileId } = req.params;

    const result = await db.query<ProfileRow>(`
      SELECT id, name, avatar_url, is_kids FROM user_profiles
      WHERE id = $1 AND user_id = $2
    `, [profileId, req.session.userId]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Profile not found' });
      return;
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
router.post('/profiles', async (req: Request, res: Response): Promise<void> => {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const { name, isKids } = req.body as { name?: string; isKids?: boolean };

    if (!name) {
      res.status(400).json({ error: 'Profile name is required' });
      return;
    }

    // Check profile limit (max 6 profiles)
    const count = await db.query<{ count: string }>(`
      SELECT COUNT(*) FROM user_profiles WHERE user_id = $1
    `, [req.session.userId]);

    if (parseInt(count.rows[0].count) >= 6) {
      res.status(400).json({ error: 'Maximum profiles reached (6)' });
      return;
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
router.delete('/profiles/:profileId', async (req: Request, res: Response): Promise<void> => {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const { profileId } = req.params;

    // Check ownership and ensure not the only profile
    const profiles = await db.query<{ id: string }>(`
      SELECT id FROM user_profiles WHERE user_id = $1
    `, [req.session.userId]);

    if (profiles.rows.length <= 1) {
      res.status(400).json({ error: 'Cannot delete the only profile' });
      return;
    }

    const result = await db.query<{ id: string }>(`
      DELETE FROM user_profiles WHERE id = $1 AND user_id = $2 RETURNING id
    `, [profileId, req.session.userId]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Profile not found' });
      return;
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

export default router;
