/**
 * User profile routes for the LinkedIn clone.
 * Handles profile viewing, editing, and user search.
 * Includes experience, education, and skills management.
 *
 * @module routes/users
 */
import { Router, Request, Response } from 'express';
import * as userService from '../services/userService.js';
import { searchPeople } from '../services/searchService.js';
import { requireAuth } from '../middleware/auth.js';
import { readRateLimit, writeRateLimit, searchRateLimit } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { parseId, sendApiError } from '../utils/errors.js';
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

const router = Router();

// Get user profile (email only on your own profile)
router.get('/:id', readRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = parseId(req.params.id);
    const isSelf = req.session.userId === userId;
    const user = isSelf
      ? await userService.getUserById(userId)
      : await userService.getPublicProfile(userId);

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
    if (sendApiError(res, error)) return;
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

    // Only allowlisted profile fields are written; the search reindex is queued
    // in the same transaction (see searchIndexer).
    const user = await userService.updateUser(userId, req.body ?? {});

    // Track metrics
    profileUpdatesTotal.inc();

    // Determine changed fields for audit
    const changedFields: string[] = [];
    const previousValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};

    if (previousUser && user) {
      for (const field of userService.EDITABLE_PROFILE_FIELDS) {
        if (previousUser[field] !== user[field]) {
          changedFields.push(field);
          previousValues[field] = previousUser[field];
          newValues[field] = user[field];
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

// Search users (Elasticsearch, falling back to PostgreSQL full-text)
router.get('/', searchRateLimit, async (req: Request, res: Response) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);

    if (!query) {
      res.status(400).json({ error: 'Search query required' });
      return;
    }

    // Track metrics
    searchQueriesTotal.inc({ type: 'user' });

    const { users, source } = await searchPeople(query, limit);

    res.json({ users, source });
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
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Add experience error');
    res.status(500).json({ error: 'Failed to add experience' });
  }
});

router.patch('/me/experiences/:id', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const experienceId = parseId(req.params.id);

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
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Update experience error');
    res.status(500).json({ error: 'Failed to update experience' });
  }
});

router.delete('/me/experiences/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const experienceId = parseId(req.params.id);

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
    if (sendApiError(res, error)) return;
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
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Add education error');
    res.status(500).json({ error: 'Failed to add education' });
  }
});

router.delete('/me/education/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const educationId = parseId(req.params.id);

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
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Delete education error');
    res.status(500).json({ error: 'Failed to delete education' });
  }
});

// Skills routes
router.post('/me/skills', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { name } = req.body ?? {};

    if (!name || typeof name !== 'string') {
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
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Add skill error');
    res.status(500).json({ error: 'Failed to add skill' });
  }
});

router.delete('/me/skills/:skillId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const skillId = parseId(req.params.skillId, 'skillId');

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
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Remove skill error');
    res.status(500).json({ error: 'Failed to remove skill' });
  }
});

// Endorse a skill (1st-degree connections only, once per endorser and skill)
router.post('/:userId/skills/:skillId/endorse', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = parseId(req.params.userId, 'userId');
    const skillId = parseId(req.params.skillId, 'skillId');

    if (userId === req.session.userId) {
      res.status(400).json({ error: 'Cannot endorse your own skill' });
      return;
    }

    const changed = await userService.endorseSkill(req.session.userId!, userId, skillId);

    logger.info(
      { endorserId: req.session.userId, targetUserId: userId, skillId, changed },
      'Skill endorsed'
    );

    res.json({ message: changed ? 'Skill endorsed' : 'Already endorsed', changed });
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Endorse skill error');
    res.status(500).json({ error: 'Failed to endorse skill' });
  }
});

export default router;
