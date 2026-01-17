/**
 * User profile routes for the LinkedIn clone.
 * Handles profile viewing, editing, and user search.
 * Includes experience, education, and skills management.
 *
 * @module routes/users
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as userService from '../services/userService.js';
import { requireAuth } from '../middleware/auth.js';
import { searchUsers } from '../utils/elasticsearch.js';
import { readRateLimit, writeRateLimit, searchRateLimit } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';
import {
  profileViewsTotal,
  profileUpdatesTotal,
  searchQueriesTotal,
} from '../utils/metrics.js';
import {
  logProfileUpdate,
  createAuditLog,
  AuditEventType,
} from '../utils/audit.js';
import {
  publishToQueue,
  QUEUES,
  ProfileUpdateEvent,
} from '../utils/rabbitmq.js';

const router = Router();

// Get user profile
router.get('/:id', readRateLimit, async (req: Request, res: Response) => {
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

    // Track profile view (only if viewer is different from profile owner)
    if (req.session.userId && req.session.userId !== userId) {
      profileViewsTotal.inc();
    }

    res.json({
      user,
      experiences,
      education,
      skills,
    });
  } catch (error) {
    logger.error({ error, targetUserId: req.params.id }, 'Get profile error');
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Update profile
router.patch('/me', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;

    // Get current profile for audit comparison
    const previousUser = await userService.getUserById(userId);

    const user = await userService.updateUser(userId, req.body);

    // Track metrics
    profileUpdatesTotal.inc();

    // Determine changed fields for audit
    const changedFields: string[] = [];
    const previousValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};

    if (previousUser) {
      for (const [key, value] of Object.entries(req.body)) {
        if (previousUser[key as keyof typeof previousUser] !== value) {
          changedFields.push(key);
          previousValues[key] = previousUser[key as keyof typeof previousUser];
          newValues[key] = value;
        }
      }
    }

    // Audit log profile update
    if (changedFields.length > 0) {
      await logProfileUpdate(
        userId,
        req.ip || 'unknown',
        changedFields,
        previousValues,
        newValues
      );

      // Publish profile update event for search indexing
      const profileEvent: ProfileUpdateEvent = {
        type: 'profile.updated',
        userId,
        changedFields,
        idempotencyKey: uuidv4(),
        timestamp: new Date().toISOString(),
      };
      await publishToQueue(QUEUES.SEARCH_INDEX, profileEvent);
    }

    logger.info(
      { userId, changedFields },
      'Profile updated'
    );

    res.json({ user });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Update profile error');
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Search users
router.get('/', searchRateLimit, async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    const limit = parseInt(req.query.limit as string) || 20;

    if (!query) {
      res.status(400).json({ error: 'Search query required' });
      return;
    }

    // Track metrics
    searchQueriesTotal.inc({ type: 'user' });

    const userIds = await searchUsers(query, limit);
    const users = await userService.getUsersByIds(userIds);

    res.json({ users });
  } catch (error) {
    logger.error({ error, query: req.query.q }, 'Search users error');
    res.status(500).json({ error: 'Search failed' });
  }
});

// Experience routes
router.post('/me/experiences', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;

    const experience = await userService.addExperience(userId, {
      ...req.body,
      start_date: new Date(req.body.start_date),
      end_date: req.body.end_date ? new Date(req.body.end_date) : undefined,
    });

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.EXPERIENCE_ADDED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'profile',
      targetId: userId,
      action: 'add_experience',
      details: {
        experienceId: experience.id,
        companyName: experience.company_name,
        title: experience.title,
      },
    });

    logger.info(
      { userId, experienceId: experience.id },
      'Experience added'
    );

    res.status(201).json({ experience });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Add experience error');
    res.status(500).json({ error: 'Failed to add experience' });
  }
});

router.patch('/me/experiences/:id', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const experienceId = parseInt(req.params.id);

    const experience = await userService.updateExperience(
      experienceId,
      userId,
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

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.EXPERIENCE_UPDATED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'profile',
      targetId: userId,
      action: 'update_experience',
      details: {
        experienceId,
        changedFields: Object.keys(req.body),
      },
    });

    logger.info(
      { userId, experienceId },
      'Experience updated'
    );

    res.json({ experience });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Update experience error');
    res.status(500).json({ error: 'Failed to update experience' });
  }
});

router.delete('/me/experiences/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const experienceId = parseInt(req.params.id);

    const deleted = await userService.deleteExperience(experienceId, userId);
    if (!deleted) {
      res.status(404).json({ error: 'Experience not found' });
      return;
    }

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.EXPERIENCE_DELETED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'profile',
      targetId: userId,
      action: 'delete_experience',
      details: { experienceId },
    });

    logger.info(
      { userId, experienceId },
      'Experience deleted'
    );

    res.json({ message: 'Experience deleted' });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Delete experience error');
    res.status(500).json({ error: 'Failed to delete experience' });
  }
});

// Education routes
router.post('/me/education', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;

    const education = await userService.addEducation(userId, req.body);

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.EDUCATION_ADDED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'profile',
      targetId: userId,
      action: 'add_education',
      details: {
        educationId: education.id,
        schoolName: education.school_name,
        degree: education.degree,
      },
    });

    logger.info(
      { userId, educationId: education.id },
      'Education added'
    );

    res.status(201).json({ education });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Add education error');
    res.status(500).json({ error: 'Failed to add education' });
  }
});

router.delete('/me/education/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const educationId = parseInt(req.params.id);

    const deleted = await userService.deleteEducation(educationId, userId);
    if (!deleted) {
      res.status(404).json({ error: 'Education not found' });
      return;
    }

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.EDUCATION_DELETED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'profile',
      targetId: userId,
      action: 'delete_education',
      details: { educationId },
    });

    logger.info(
      { userId, educationId },
      'Education deleted'
    );

    res.json({ message: 'Education deleted' });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Delete education error');
    res.status(500).json({ error: 'Failed to delete education' });
  }
});

// Skills routes
router.post('/me/skills', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { name } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Skill name required' });
      return;
    }

    await userService.addUserSkill(userId, name);
    const skills = await userService.getUserSkills(userId);

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.SKILL_ADDED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'profile',
      targetId: userId,
      action: 'add_skill',
      details: { skillName: name },
    });

    logger.info(
      { userId, skillName: name },
      'Skill added'
    );

    res.json({ skills });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Add skill error');
    res.status(500).json({ error: 'Failed to add skill' });
  }
});

router.delete('/me/skills/:skillId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const skillId = parseInt(req.params.skillId);

    const deleted = await userService.removeUserSkill(userId, skillId);
    if (!deleted) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.SKILL_REMOVED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'profile',
      targetId: userId,
      action: 'remove_skill',
      details: { skillId },
    });

    logger.info(
      { userId, skillId },
      'Skill removed'
    );

    res.json({ message: 'Skill removed' });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Remove skill error');
    res.status(500).json({ error: 'Failed to remove skill' });
  }
});

// Endorse a skill
router.post('/:userId/skills/:skillId/endorse', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const skillId = parseInt(req.params.skillId);

    if (userId === req.session.userId) {
      res.status(400).json({ error: 'Cannot endorse your own skill' });
      return;
    }

    await userService.endorseSkill(userId, skillId);

    logger.info(
      { endorserId: req.session.userId, targetUserId: userId, skillId },
      'Skill endorsed'
    );

    res.json({ message: 'Skill endorsed' });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Endorse skill error');
    res.status(500).json({ error: 'Failed to endorse skill' });
  }
});

export default router;
