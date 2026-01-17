import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import type { User } from '../types/index.js';

const router = Router();

// Get all users (for testing - list contacts)
router.get('/', async (req: Request, res: Response) => {
  try {
    const users = await query<User>(
      'SELECT id, username, display_name, avatar_url, role, created_at FROM users ORDER BY display_name'
    );
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get user by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = await queryOne<User>(
      'SELECT id, username, display_name, avatar_url, role, created_at FROM users WHERE id = $1',
      [id]
    );

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Simple login (for testing - no real auth)
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username } = req.body;

    if (!username) {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    const user = await queryOne<User>(
      'SELECT id, username, display_name, avatar_url, role FROM users WHERE username = $1',
      [username]
    );

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // In production, you'd use proper session management
    res.json({
      success: true,
      user,
    });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

export default router;
