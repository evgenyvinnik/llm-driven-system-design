import { Router, Request, Response } from 'express';
import {
  findUserByUsername,
  findUserById,
  validatePassword,
  createUser,
  searchUsers,
  getAllUsers,
  getUserPresence,
} from '../services/userService.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await validatePassword(username, password);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;

    res.json({ user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, displayName, password } = req.body;

    if (!username || !displayName || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await findUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const user = await createUser(username, displayName, password);
    req.session.userId = user.id;

    res.status(201).json({ user });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout
router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ success: true });
  });
});

// Get current user
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await findUserById(req.session.userId!);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search users
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;

    if (!query || query.length < 1) {
      const users = await getAllUsers(req.session.userId);
      return res.json({ users });
    }

    const users = await searchUsers(query, req.session.userId);
    res.json({ users });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user by ID
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await findUserById(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const presence = await getUserPresence(user.id);

    res.json({
      user: {
        ...user,
        presence: presence || { status: 'offline', last_seen: 0 },
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
