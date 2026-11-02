import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { cacheDelPattern } from '../services/redis.js';
import { publishToQueue } from '../services/queue.js';
import { config } from '../config/index.js';
import {
  AccessError,
  callerFrom,
  isUuid,
  requireSpace,
  respondError,
  visibleSpaceIds,
} from '../services/accessService.js';

const router = Router();

const ROLES = new Set(['admin', 'member', 'viewer']);

// Spaces the caller can see: public spaces plus their private memberships
router.get('/', async (req: Request, res: Response) => {
  try {
    const ids = await visibleSpaceIds(callerFrom(req));
    const result = await pool.query(
      `SELECT s.*, u.username as creator_username,
              (SELECT COUNT(*) FROM pages WHERE space_id = s.id AND status = 'published') as page_count
       FROM spaces s
       JOIN users u ON u.id = s.created_by
       WHERE s.id = ANY($1::uuid[])
       ORDER BY s.name ASC`,
      [ids],
    );
    res.json({ spaces: result.rows });
  } catch (err) {
    respondError(res, err, 'Failed to list spaces');
  }
});

// Space by key, with the caller's access to it
router.get('/:key', async (req: Request, res: Response) => {
  try {
    const access = await requireSpace({ key: req.params.key }, callerFrom(req), 'view');
    const result = await pool.query(
      `SELECT s.*, u.username as creator_username
       FROM spaces s
       JOIN users u ON u.id = s.created_by
       WHERE s.id = $1`,
      [access.spaceId],
    );
    res.json({
      space: result.rows[0],
      access: { role: access.role, canEdit: access.canEdit, canAdmin: access.canAdmin },
    });
  } catch (err) {
    respondError(res, err, 'Failed to get space');
  }
});

// Create space; the creator becomes its admin
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { key, name, description, isPublic } = req.body;

    if (!key || !name) {
      res.status(400).json({ error: 'Key and name are required' });
      return;
    }

    if (String(key).length > 10 || !/^[A-Z]+$/.test(String(key).toUpperCase())) {
      res.status(400).json({ error: 'Key must be 1-10 uppercase letters' });
      return;
    }

    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO spaces (key, name, description, is_public, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [String(key).toUpperCase(), name, description || null, isPublic !== false, req.session.userId],
    );
    const space = result.rows[0];
    await client.query(
      `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [space.id, req.session.userId],
    );
    await client.query('COMMIT');

    logger.info({ spaceId: space.id, key }, 'Space created');
    res.status(201).json({ space });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'A space with that key already exists' });
      return;
    }
    respondError(res, err, 'Failed to create space');
  } finally {
    client.release();
  }
});

// Update space settings (space admins)
router.put('/:key', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireSpace({ key: req.params.key }, callerFrom(req), 'admin');
    const { name, description, isPublic } = req.body;

    const result = await pool.query(
      `UPDATE spaces SET name = COALESCE($1, name), description = COALESCE($2, description),
       is_public = COALESCE($3, is_public), updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [name ?? null, description ?? null, typeof isPublic === 'boolean' ? isPublic : null, access.spaceId],
    );

    res.json({ space: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to update space');
  }
});

// Delete space (space admins). Its pages leave the search index too.
router.delete('/:key', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireSpace({ key: req.params.key }, callerFrom(req), 'admin');
    const pages = await pool.query('SELECT id FROM pages WHERE space_id = $1', [access.spaceId]);
    await pool.query('DELETE FROM spaces WHERE id = $1', [access.spaceId]);

    try {
      await cacheDelPattern(`space:${access.spaceId}:*`);
      for (const { id } of pages.rows as { id: string }[]) await cacheDelPattern(`page:${id}:*`);
    } catch (err) {
      logger.warn({ err }, 'Cache invalidation failed after space delete');
    }
    await publishToQueue(config.rabbitmq.pageIndexQueue, {
      action: 'delete-space',
      spaceId: access.spaceId,
    });

    logger.info({ key: access.spaceKey }, 'Space deleted');
    res.json({ message: 'Space deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete space');
  }
});

// Members of a space (anyone who can view it)
router.get('/:key/members', async (req: Request, res: Response) => {
  try {
    const access = await requireSpace({ key: req.params.key }, callerFrom(req), 'view');
    const result = await pool.query(
      `SELECT sm.space_id, sm.user_id, sm.role, sm.created_at, u.username, u.display_name
       FROM space_members sm
       JOIN users u ON u.id = sm.user_id
       WHERE sm.space_id = $1
       ORDER BY sm.role, u.username`,
      [access.spaceId],
    );
    res.json({ members: result.rows });
  } catch (err) {
    respondError(res, err, 'Failed to get members');
  }
});

/** Throws if removing or demoting `userId` would leave the space with no admin. */
async function assertAnotherAdmin(spaceId: string, userId: string): Promise<void> {
  const others = await pool.query(
    `SELECT 1 FROM space_members WHERE space_id = $1 AND role = 'admin' AND user_id <> $2 LIMIT 1`,
    [spaceId, userId],
  );
  if (others.rows.length === 0) {
    throw new AccessError(409, 'A space must keep at least one admin');
  }
}

// Add a member or change their role (space admins). Accepts userId or username.
router.post('/:key/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireSpace({ key: req.params.key }, callerFrom(req), 'admin');
    const { userId, username } = req.body;
    const role = req.body.role ?? 'member';
    if (!ROLES.has(role)) {
      res.status(400).json({ error: 'Role must be admin, member, or viewer' });
      return;
    }

    const user = await pool.query(
      isUuid(userId) ? 'SELECT id FROM users WHERE id = $1' : 'SELECT id FROM users WHERE username = $1',
      [isUuid(userId) ? userId : String(username ?? '').toLowerCase()],
    );
    if (!user.rows[0]) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const targetId: string = user.rows[0].id;
    if (role !== 'admin') await assertAnotherAdmin(access.spaceId, targetId);

    const result = await pool.query(
      `INSERT INTO space_members (space_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (space_id, user_id) DO UPDATE SET role = $3
       RETURNING space_id, user_id, role, created_at`,
      [access.spaceId, targetId, role],
    );

    res.status(201).json({ member: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to add member');
  }
});

// Remove a member (space admins)
router.delete('/:key/members/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireSpace({ key: req.params.key }, callerFrom(req), 'admin');
    if (!isUuid(req.params.userId)) throw new AccessError(404, 'Member not found');
    await assertAnotherAdmin(access.spaceId, req.params.userId);
    const result = await pool.query(
      'DELETE FROM space_members WHERE space_id = $1 AND user_id = $2 RETURNING user_id',
      [access.spaceId, req.params.userId],
    );
    if (result.rows.length === 0) throw new AccessError(404, 'Member not found');
    res.json({ message: 'Member removed' });
  } catch (err) {
    respondError(res, err, 'Failed to remove member');
  }
});

/** Router for space CRUD, member management, and space listing. */
export default router;
