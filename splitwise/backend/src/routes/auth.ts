import express, { type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool.js';
import { setSession, deleteSession } from '../db/redis.js';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';

const router = express.Router();

interface UserRow {
  id: string;
  username: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  password_hash?: string;
  role: string;
}

interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  name?: string;
}

interface LoginRequest {
  username: string;
  password: string;
}

// Register new user
router.post('/register', async (req: Request<object, unknown, RegisterRequest>, res: Response): Promise<void> => {
  try {
    const { username, email, password, name } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({ error: 'Username, email, and password are required' });
      return;
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username.toLowerCase(), email.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      res.status(400).json({ error: 'Username or email already taken' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name || username)}`;

    const result = await pool.query<UserRow>(
      `INSERT INTO users (username, email, password_hash, name, avatar_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, name, avatar_url, role`,
      [username.toLowerCase(), email.toLowerCase(), passwordHash, name || username, avatarUrl]
    );
    const user = result.rows[0];

    const sessionId = uuidv4();
    await setSession(sessionId, user.id);

    res.status(201).json({ user, sessionId });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login (accepts username or email)
router.post('/login', async (req: Request<object, unknown, LoginRequest>, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const result = await pool.query<UserRow>(
      'SELECT id, username, email, name, avatar_url, password_hash, role FROM users WHERE username = $1 OR email = $1',
      [username.toLowerCase()]
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash || '');
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const sessionId = uuidv4();
    await setSession(sessionId, user.id);

    const { password_hash: _unused, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword, sessionId });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
router.post('/logout', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    await deleteSession((req as AuthenticatedRequest).sessionId);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Current user
router.get('/me', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  res.json((req as AuthenticatedRequest).user);
});

// Search users (to add to groups / expenses)
router.get('/search', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { q } = req.query;
    if (!q || (typeof q === 'string' && q.length < 1)) {
      res.json([]);
      return;
    }
    const result = await pool.query(
      `SELECT id, username, name, avatar_url FROM users
       WHERE id <> $1 AND (username ILIKE $2 OR name ILIKE $2 OR email ILIKE $2)
       ORDER BY name LIMIT 10`,
      [authReq.user.id, `%${q}%`]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
