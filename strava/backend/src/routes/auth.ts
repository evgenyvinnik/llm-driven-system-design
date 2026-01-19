import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../utils/db.js';
import { cacheUser } from '../utils/redis.js';
import { AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

interface RegisterBody {
  username: string;
  email: string;
  password: string;
  weightKg?: number;
  bio?: string;
  location?: string;
}

interface LoginBody {
  email: string;
  password: string;
}

interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  weight_kg: number | null;
  bio: string | null;
  location: string | null;
  role: string;
  profile_photo: string | null;
  created_at: Date;
}

// Register new user
router.post('/register', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { username, email, password, weightKg, bio, location } = req.body as RegisterBody;

    if (!username || !email || !password) {
      res.status(400).json({ error: 'Username, email, and password are required' });
      return;
    }

    // Check if user exists
    const existing = await query<{ id: string }>(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existing.rows.length > 0) {
      res.status(400).json({ error: 'Username or email already exists' });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await query<UserRow>(
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
    await cacheUser(user.id, {
      id: user.id,
      username: user.username,
      email: user.email,
      bio: user.bio || undefined,
      location: user.location || undefined,
      role: user.role
    });

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
router.post('/login', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body as LoginBody;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const result = await query<UserRow>(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    // Cache user
    await cacheUser(user.id, {
      id: user.id,
      username: user.username,
      email: user.email,
      profile_photo: user.profile_photo || undefined,
      bio: user.bio || undefined,
      location: user.location || undefined,
      role: user.role
    });

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
router.post('/logout', (req: AuthenticatedRequest, res: Response): void => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: 'Logout failed' });
      return;
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out successfully' });
  });
});

// Get current user
router.get('/me', (req: AuthenticatedRequest, res: Response): void => {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
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
