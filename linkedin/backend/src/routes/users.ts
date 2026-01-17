import { Router, Request, Response } from 'express';
import * as userService from '../services/userService.js';
import { requireAuth } from '../middleware/auth.js';
import { searchUsers } from '../utils/elasticsearch.js';

const router = Router();

// Get user profile
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    const user = await userService.getUserById(userId);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [experiences, education, skills] = await Promise.all([
      userService.getUserExperiences(userId),
      userService.getUserEducation(userId),
      userService.getUserSkills(userId),
    ]);

    res.json({
      user,
      experiences,
      education,
      skills,
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Update profile
router.patch('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await userService.updateUser(req.session.userId!, req.body);
    res.json({ user });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Search users
router.get('/', async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    const limit = parseInt(req.query.limit as string) || 20;

    if (!query) {
      res.status(400).json({ error: 'Search query required' });
      return;
    }

    const userIds = await searchUsers(query, limit);
    const users = await userService.getUsersByIds(userIds);

    res.json({ users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Experience routes
router.post('/me/experiences', requireAuth, async (req: Request, res: Response) => {
  try {
    const experience = await userService.addExperience(req.session.userId!, {
      ...req.body,
      start_date: new Date(req.body.start_date),
      end_date: req.body.end_date ? new Date(req.body.end_date) : undefined,
    });
    res.status(201).json({ experience });
  } catch (error) {
    console.error('Add experience error:', error);
    res.status(500).json({ error: 'Failed to add experience' });
  }
});

router.patch('/me/experiences/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const experience = await userService.updateExperience(
      parseInt(req.params.id),
      req.session.userId!,
      {
        ...req.body,
        start_date: req.body.start_date ? new Date(req.body.start_date) : undefined,
        end_date: req.body.end_date === null ? null : req.body.end_date ? new Date(req.body.end_date) : undefined,
      }
    );

    if (!experience) {
      res.status(404).json({ error: 'Experience not found' });
      return;
    }

    res.json({ experience });
  } catch (error) {
    console.error('Update experience error:', error);
    res.status(500).json({ error: 'Failed to update experience' });
  }
});

router.delete('/me/experiences/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const deleted = await userService.deleteExperience(parseInt(req.params.id), req.session.userId!);
    if (!deleted) {
      res.status(404).json({ error: 'Experience not found' });
      return;
    }
    res.json({ message: 'Experience deleted' });
  } catch (error) {
    console.error('Delete experience error:', error);
    res.status(500).json({ error: 'Failed to delete experience' });
  }
});

// Education routes
router.post('/me/education', requireAuth, async (req: Request, res: Response) => {
  try {
    const education = await userService.addEducation(req.session.userId!, req.body);
    res.status(201).json({ education });
  } catch (error) {
    console.error('Add education error:', error);
    res.status(500).json({ error: 'Failed to add education' });
  }
});

router.delete('/me/education/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const deleted = await userService.deleteEducation(parseInt(req.params.id), req.session.userId!);
    if (!deleted) {
      res.status(404).json({ error: 'Education not found' });
      return;
    }
    res.json({ message: 'Education deleted' });
  } catch (error) {
    console.error('Delete education error:', error);
    res.status(500).json({ error: 'Failed to delete education' });
  }
});

// Skills routes
router.post('/me/skills', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Skill name required' });
      return;
    }

    await userService.addUserSkill(req.session.userId!, name);
    const skills = await userService.getUserSkills(req.session.userId!);
    res.json({ skills });
  } catch (error) {
    console.error('Add skill error:', error);
    res.status(500).json({ error: 'Failed to add skill' });
  }
});

router.delete('/me/skills/:skillId', requireAuth, async (req: Request, res: Response) => {
  try {
    const deleted = await userService.removeUserSkill(req.session.userId!, parseInt(req.params.skillId));
    if (!deleted) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    res.json({ message: 'Skill removed' });
  } catch (error) {
    console.error('Remove skill error:', error);
    res.status(500).json({ error: 'Failed to remove skill' });
  }
});

// Endorse a skill
router.post('/:userId/skills/:skillId/endorse', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const skillId = parseInt(req.params.skillId);

    if (userId === req.session.userId) {
      res.status(400).json({ error: 'Cannot endorse your own skill' });
      return;
    }

    await userService.endorseSkill(userId, skillId);
    res.json({ message: 'Skill endorsed' });
  } catch (error) {
    console.error('Endorse skill error:', error);
    res.status(500).json({ error: 'Failed to endorse skill' });
  }
});

export default router;
