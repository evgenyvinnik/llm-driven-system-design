import { Router, Request, Response } from 'express';
import { authenticateRequest, AuthenticatedRequest } from '../middleware/auth.js';
import { searchUsers, getUserById, updateUser } from '../services/users.js';

const router = Router();

router.use(authenticateRequest as any);

router.get('/search', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { q, limit } = req.query;

    if (!q || (q as string).length < 2) {
      res.status(400).json({ error: 'Search query must be at least 2 characters' });
      return;
    }

    const users = await searchUsers(q as string, authReq.user.id, limit ? parseInt(limit as string) : 20);
    res.json({ users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserById(req.params.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

router.patch('/me', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { displayName, avatarUrl } = req.body;
    const user = await updateUser(authReq.user.id, {
      display_name: displayName,
      avatar_url: avatarUrl,
    });
    res.json({ user });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

export default router;
