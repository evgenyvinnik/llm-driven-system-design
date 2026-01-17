import { Router, Request, Response } from 'express';
import { userService } from '../services/userService.js';

const router = Router();

// Get all users
router.get('/', async (_req: Request, res: Response) => {
  try {
    const users = await userService.getAllUsers();
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get user by ID
router.get('/:userId', async (req: Request, res: Response) => {
  try {
    const user = await userService.getUser(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Create user
router.post('/', async (req: Request, res: Response) => {
  try {
    const { username, display_name, avatar_url } = req.body;
    if (!username || !display_name) {
      return res.status(400).json({ error: 'username and display_name are required' });
    }
    const user = await userService.createUser(username, display_name, avatar_url);
    res.status(201).json(user);
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Ban user
router.post('/:userId/ban', async (req: Request, res: Response) => {
  try {
    const { banned_by, reason, stream_id, expires_at } = req.body;
    if (!banned_by) {
      return res.status(400).json({ error: 'banned_by is required' });
    }
    await userService.banUser(
      req.params.userId,
      banned_by,
      reason,
      stream_id,
      expires_at ? new Date(expires_at) : undefined
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error banning user:', error);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

// Unban user
router.delete('/:userId/ban', async (req: Request, res: Response) => {
  try {
    const { stream_id } = req.query;
    await userService.unbanUser(req.params.userId, stream_id as string);
    res.json({ success: true });
  } catch (error) {
    console.error('Error unbanning user:', error);
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

export default router;
