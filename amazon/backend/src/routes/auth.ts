import { Router } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { body, validationResult } from 'express-validator';
import { query } from '../services/database.js';
import { setSession, deleteSession } from '../services/redis.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Register
router.post('/register',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().notEmpty(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password, name } = req.body;

      // Check if email exists
      const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Create user
      const result = await query(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, $2, $3)
         RETURNING id, email, name, role`,
        [email, passwordHash, name]
      );

      const user = result.rows[0];

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
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password } = req.body;

      // Find user
      const result = await query(
        'SELECT id, email, name, role, password_hash FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = result.rows[0];

      // Verify password
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Create session
      const sessionId = uuidv4();
      await setSession(sessionId, { userId: user.id }, 86400 * 7);

      delete user.password_hash;

      res.json({
        user,
        sessionId
      });
    } catch (error) {
      next(error);
    }
  }
);

// Logout
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await deleteSession(req.sessionId);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
});

// Get current user
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Update profile
router.put('/profile', requireAuth,
  body('name').optional().trim().notEmpty(),
  async (req, res, next) => {
    try {
      const { name } = req.body;

      const result = await query(
        `UPDATE users SET name = COALESCE($1, name), updated_at = NOW()
         WHERE id = $2
         RETURNING id, email, name, role`,
        [name, req.user.id]
      );

      res.json({ user: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
