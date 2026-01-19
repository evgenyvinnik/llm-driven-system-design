import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { body, validationResult } from 'express-validator';
import { query } from '../services/database.js';
import { setSession, deleteSession } from '../services/redis.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: 'user' | 'admin' | 'seller';
  password_hash?: string;
}

// Register
router.post('/register',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().notEmpty(),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { email, password, name } = req.body;

      // Check if email exists
      const existing = await query<{ id: number }>('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        res.status(409).json({ error: 'Email already registered' });
        return;
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Create user
      const result = await query<UserRow>(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, $2, $3)
         RETURNING id, email, name, role`,
        [email, passwordHash, name]
      );

      const user = result.rows[0];
      if (!user) {
        res.status(500).json({ error: 'Failed to create user' });
        return;
      }

      // Create session
      const sessionId = uuidv4();
      await setSession(sessionId, { userId: user.id }, 86400 * 7);

      res.status(201).json({
        user,
        sessionId
      });
    } catch (error) {
      next(error);
    }
  }
);

// Login
router.post('/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ errors: errors.array() });
        return;
      }

      const { email, password } = req.body;

      // Find user
      const result = await query<UserRow>(
        'SELECT id, email, name, role, password_hash FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      const user = result.rows[0];
      if (!user) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      // Verify password
      const valid = await bcrypt.compare(password, user.password_hash || '');
      if (!valid) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      // Create session
      const sessionId = uuidv4();
      await setSession(sessionId, { userId: user.id }, 86400 * 7);

      // Remove password_hash from response
      const { password_hash, ...userWithoutPassword } = user;

      res.json({
        user: userWithoutPassword,
        sessionId
      });
    } catch (error) {
      next(error);
    }
  }
);

// Logout
router.post('/logout', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.sessionId) {
      await deleteSession(req.sessionId);
    }
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
});

// Get current user
router.get('/me', requireAuth, (req: Request, res: Response): void => {
  res.json({ user: req.user });
});

// Update profile
router.put('/profile', requireAuth,
  body('name').optional().trim().notEmpty(),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { name } = req.body;

      const result = await query<UserRow>(
        `UPDATE users SET name = COALESCE($1, name), updated_at = NOW()
         WHERE id = $2
         RETURNING id, email, name, role`,
        [name, req.user!.id]
      );

      res.json({ user: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
