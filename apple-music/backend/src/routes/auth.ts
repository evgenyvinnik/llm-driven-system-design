import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/index.js';
import { redis } from '../services/redis.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

interface RegisterBody {
  email: string;
  username: string;
  password: string;
  displayName?: string;
}

interface LoginBody {
  email: string;
  password: string;
}

interface PreferencesBody {
  preferredQuality?: string;
  displayName?: string;
}

// Register new user
router.post('/register', async (req: Request<object, unknown, RegisterBody>, res: Response) => {
  try {
    const { email, username, password, displayName } = req.body;

    if (!email || !username || !password) {
      res.status(400).json({ error: 'Email, username, and password are required' });
      return;
    }

    // Check if user exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );

    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'User already exists' });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await pool.query(
      `INSERT INTO users (email, username, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, username, display_name, role, subscription_tier, preferred_quality`,
      [email, username, passwordHash, displayName || username]
    );

    const user = result.rows[0];

    // Create session
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `INSERT INTO sessions (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, token, expiresAt]
    );

    // Cache session in Redis
    await redis.setex(
      `session:${token}`,
      7 * 24 * 60 * 60,
      JSON.stringify({
        userId: user.id,
        email: user.email,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        subscriptionTier: user.subscription_tier,
        preferredQuality: user.preferred_quality
      })
    );

    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        subscriptionTier: user.subscription_tier,
        preferredQuality: user.preferred_quality
      },
      token
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req: Request<object, unknown, LoginBody>, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    // Find user
    const result = await pool.query(
      `SELECT id, email, username, password_hash, display_name, role,
              subscription_tier, preferred_quality
       FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Create session
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO sessions (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, token, expiresAt]
    );

    // Cache session in Redis
    await redis.setex(
      `session:${token}`,
      7 * 24 * 60 * 60,
      JSON.stringify({
        userId: user.id,
        email: user.email,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        subscriptionTier: user.subscription_tier,
        preferredQuality: user.preferred_quality
      })
    );

    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        subscriptionTier: user.subscription_tier,
        preferredQuality: user.preferred_quality
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  try {
    const token = req.cookies.session_token || req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
      await redis.del(`session:${token}`);
    }

    res.clearCookie('session_token');
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Get current user
router.get('/me', authenticate, async (req: Request, res: Response) => {
  res.json({ user: req.user });
});

// Update user preferences
router.patch('/preferences', authenticate, async (req: Request<object, unknown, PreferencesBody>, res: Response) => {
  try {
    const { preferredQuality, displayName } = req.body;
    const updates: string[] = [];
    const values: (string | undefined)[] = [];
    let paramCount = 1;

    if (preferredQuality) {
      updates.push(`preferred_quality = $${paramCount++}`);
      values.push(preferredQuality);
    }

    if (displayName) {
      updates.push(`display_name = $${paramCount++}`);
      values.push(displayName);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.user!.id);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING id, email, username, display_name, role, subscription_tier, preferred_quality`,
      values
    );

    // Update cached session
    const token = req.cookies.session_token || req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      const user = result.rows[0];
      await redis.setex(
        `session:${token}`,
        7 * 24 * 60 * 60,
        JSON.stringify({
          userId: user.id,
          email: user.email,
          username: user.username,
          displayName: user.display_name,
          role: user.role,
          subscriptionTier: user.subscription_tier,
          preferredQuality: user.preferred_quality
        })
      );
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

export default router;
