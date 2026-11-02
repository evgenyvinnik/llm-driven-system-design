import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../services/db.js';
import { logger } from '../services/logger.js';
import { AccessError, callerFrom, isUuid, requireSpace, respondError } from '../services/accessService.js';

/** A space template is visible to whoever can view its space; global templates to everyone. */
async function assertTemplateVisible(template: { is_global: boolean; space_id: string | null }, req: Request) {
  if (template.is_global || !template.space_id) return;
  await requireSpace({ id: template.space_id }, callerFrom(req), 'view').catch(() => {
    throw new AccessError(404, 'Template not found');
  });
}

const router = Router();

// List templates (global + space-specific)
router.get('/', async (req: Request, res: Response) => {
  try {
    const spaceId = req.query.spaceId as string;
    if (spaceId) await requireSpace({ id: spaceId }, callerFrom(req), 'view');

    let query = `
      SELECT t.*, u.username as creator_username
      FROM templates t
      JOIN users u ON u.id = t.created_by
      WHERE t.is_global = true
    `;
    const params: string[] = [];

    if (spaceId) {
      query += ' OR t.space_id = $1';
      params.push(spaceId);
    }

    query += ' ORDER BY t.name ASC';

    const result = await pool.query(query, params);
    res.json({ templates: result.rows });
  } catch (err) {
    respondError(res, err, 'Failed to list templates');
  }
});

// Get template by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) throw new AccessError(404, 'Template not found');
    const result = await pool.query(
      `SELECT t.*, u.username as creator_username
       FROM templates t
       JOIN users u ON u.id = t.created_by
       WHERE t.id = $1`,
      [req.params.id],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }
    await assertTemplateVisible(result.rows[0], req);

    res.json({ template: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to get template');
  }
});

// Create template
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, description, contentJson, spaceId, isGlobal } = req.body;

    if (!name || !contentJson) {
      res.status(400).json({ error: 'Name and content are required' });
      return;
    }
    // Global templates appear in every space, so only global admins create them;
    // a space template needs edit access to that space.
    if (isGlobal && req.session.role !== 'admin') {
      throw new AccessError(403, 'Only administrators can create global templates');
    }
    if (!isGlobal) {
      if (!spaceId) throw new AccessError(400, 'A space template needs a spaceId');
      await requireSpace({ id: spaceId }, callerFrom(req), 'edit');
    }

    const result = await pool.query(
      `INSERT INTO templates (name, description, content_json, space_id, is_global, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, description || null, JSON.stringify(contentJson), isGlobal ? null : spaceId, Boolean(isGlobal), req.session.userId],
    );

    logger.info({ templateId: result.rows[0].id }, 'Template created');
    res.status(201).json({ template: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to create template');
  }
});

// Delete template
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) throw new AccessError(404, 'Template not found');
    const found = await pool.query('SELECT created_by, space_id, is_global FROM templates WHERE id = $1', [
      req.params.id,
    ]);
    const template = found.rows[0];
    if (!template) throw new AccessError(404, 'Template not found');
    // Its creator, an admin of its space, or a global admin may delete it.
    if (template.created_by !== req.session.userId && req.session.role !== 'admin') {
      if (!template.space_id) throw new AccessError(403, 'Only administrators can delete global templates');
      await requireSpace({ id: template.space_id }, callerFrom(req), 'admin');
    }

    await pool.query('DELETE FROM templates WHERE id = $1', [req.params.id]);

    res.json({ message: 'Template deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete template');
  }
});

/** Router for page template CRUD with global and space-scoped templates. */
export default router;
