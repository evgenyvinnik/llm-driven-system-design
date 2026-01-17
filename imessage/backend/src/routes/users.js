import { Router } from 'express';
import { authenticateRequest } from '../middleware/auth.js';
import { searchUsers, getUserById, updateUser } from '../services/users.js';

const router = Router();

router.use(authenticateRequest);

router.get('/search', async (req, res) => {
  try {
    const { q, limit } = req.query;

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const users = await searchUsers(q, req.user.id, limit ? parseInt(limit) : 20);
    res.json({ users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const user = await getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

router.patch('/me', async (req, res) => {
  try {
    const { displayName, avatarUrl } = req.body;
    const user = await updateUser(req.user.id, {
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
