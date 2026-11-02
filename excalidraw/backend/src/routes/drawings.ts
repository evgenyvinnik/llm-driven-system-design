import { Router, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { query } from '../services/db.js';
import {
  createDrawing,
  getDrawing,
  updateDrawing,
  deleteDrawing,
  listUserDrawings,
  addCollaborator,
  removeCollaborator,
  getCollaborators,
  hasAccess,
  saveVersion,
} from '../services/drawingService.js';
import { drawingRateLimiter } from '../services/rateLimiter.js';
import { isValidElement } from '../websocket/handler.js';
import { closeRoom, mergeHttpSave, refreshRoomAccess } from '../websocket/rooms.js';
import type { CrdtElement } from '../services/crdtService.js';
import logger from '../services/logger.js';
import { drawingsCreatedTotal, drawingsDeletedTotal } from '../services/metrics.js';

const router = Router();

// List user's drawings (owned + shared)
router.get('/', requireAuth as never, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const drawings = await listUserDrawings(userId);

    res.json({
      drawings: drawings.map((d) => ({
        id: d.id,
        title: d.title,
        ownerId: d.owner_id,
        ownerUsername: d.owner_username,
        ownerDisplayName: d.owner_display_name,
        isPublic: d.is_public,
        permission: d.permission,
        elementCount: Array.isArray(d.elements) ? d.elements.length : 0,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      })),
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to list drawings');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get public drawings
router.get('/public', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await query(
      `SELECT d.id, d.title, d.owner_id, d.is_public, d.created_at, d.updated_at,
              u.username as owner_username, u.display_name as owner_display_name,
              jsonb_array_length(d.elements) as element_count
       FROM drawings d
       JOIN users u ON d.owner_id = u.id
       WHERE d.is_public = true
       ORDER BY d.updated_at DESC
       LIMIT 20`
    );

    res.json({
      drawings: result.rows.map((d: Record<string, unknown>) => ({
        id: d.id,
        title: d.title,
        ownerId: d.owner_id,
        ownerUsername: d.owner_username,
        ownerDisplayName: d.owner_display_name,
        isPublic: d.is_public,
        elementCount: d.element_count,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      })),
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to list public drawings');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create drawing
router.post('/', requireAuth as never, drawingRateLimiter, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const { title, elements, appState, isPublic } = req.body;

    const drawing = await createDrawing({
      title: title || 'Untitled',
      ownerId: userId,
      elements,
      appState,
      isPublic,
    });

    drawingsCreatedTotal.inc();

    res.status(201).json({
      drawing: {
        id: drawing.id,
        title: drawing.title,
        ownerId: drawing.owner_id,
        elements: drawing.elements,
        appState: drawing.app_state,
        isPublic: drawing.is_public,
        createdAt: drawing.created_at,
        updatedAt: drawing.updated_at,
      },
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to create drawing');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single drawing
router.get('/:drawingId', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { drawingId } = req.params;
    const userId = req.session?.userId;

    const drawing = await getDrawing(drawingId);
    if (!drawing) {
      res.status(404).json({ error: 'Drawing not found' });
      return;
    }

    // Check access
    if (!drawing.is_public && userId) {
      const access = await hasAccess(drawingId, userId);
      if (!access.canView) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
    } else if (!drawing.is_public && !userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const collaborators = await getCollaborators(drawingId);

    res.json({
      drawing: {
        id: drawing.id,
        title: drawing.title,
        ownerId: drawing.owner_id,
        ownerUsername: drawing.owner_username,
        ownerDisplayName: drawing.owner_display_name,
        elements: drawing.elements,
        appState: drawing.app_state,
        isPublic: drawing.is_public,
        createdAt: drawing.created_at,
        updatedAt: drawing.updated_at,
      },
      collaborators: collaborators.map((c) => ({
        userId: c.user_id,
        username: c.username,
        displayName: c.display_name,
        permission: c.permission,
      })),
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to get drawing');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update drawing
router.put('/:drawingId', requireAuth as never, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { drawingId } = req.params;
    const userId = req.session.userId!;

    const access = await hasAccess(drawingId, userId);
    if (!access.canEdit) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const { title, elements, appState, isPublic } = req.body;

    if (elements !== undefined && (!Array.isArray(elements) || !elements.every(isValidElement))) {
      res.status(400).json({ error: 'elements must be an array of valid elements' });
      return;
    }

    // Elements are merged (last-writer-wins per element), never replaced: the
    // same rule the live room applies, so an HTTP save from a stale tab cannot
    // overwrite newer socket edits or drop tombstones.
    let merged: CrdtElement[] | null = null;
    if (elements !== undefined) {
      merged = await mergeHttpSave(drawingId, elements as CrdtElement[]);
      if (!merged) {
        res.status(404).json({ error: 'Drawing not found' });
        return;
      }
    }

    const drawing = await updateDrawing(drawingId, { title, appState, isPublic });

    if (!drawing) {
      res.status(404).json({ error: 'Drawing not found' });
      return;
    }

    // Save version snapshot of the merged scene
    if (merged) {
      saveVersion(drawingId, merged, userId).catch((err: Error) => {
        logger.error({ error: err.message }, 'Failed to save version');
      });
    }
    if (isPublic !== undefined) {
      // Making a drawing private must disconnect anonymous viewers now.
      await refreshRoomAccess(drawingId);
    }

    res.json({
      drawing: {
        id: drawing.id,
        title: drawing.title,
        ownerId: drawing.owner_id,
        elements: drawing.elements,
        appState: drawing.app_state,
        isPublic: drawing.is_public,
        createdAt: drawing.created_at,
        updatedAt: drawing.updated_at,
      },
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to update drawing');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete drawing
router.delete('/:drawingId', requireAuth as never, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { drawingId } = req.params;
    const userId = req.session.userId!;

    const access = await hasAccess(drawingId, userId);
    if (!access.isOwner) {
      res.status(403).json({ error: 'Only the owner can delete a drawing' });
      return;
    }

    const deleted = await deleteDrawing(drawingId);
    if (!deleted) {
      res.status(404).json({ error: 'Drawing not found' });
      return;
    }
    closeRoom(drawingId);

    drawingsDeletedTotal.inc();
    res.json({ message: 'Drawing deleted' });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to delete drawing');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add collaborator
router.post('/:drawingId/collaborators', requireAuth as never, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { drawingId } = req.params;
    const userId = req.session.userId!;
    const { username, permission } = req.body;

    if (!username) {
      res.status(400).json({ error: 'Username is required' });
      return;
    }
    if (permission !== undefined && permission !== 'view' && permission !== 'edit') {
      res.status(400).json({ error: "Permission must be 'view' or 'edit'" });
      return;
    }

    const access = await hasAccess(drawingId, userId);
    if (!access.isOwner) {
      res.status(403).json({ error: 'Only the owner can manage collaborators' });
      return;
    }

    // Find user by username
    const userResult = await query<{ id: string }>(
      'SELECT id FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const targetUserId = userResult.rows[0].id;

    if (targetUserId === userId) {
      res.status(400).json({ error: 'Cannot add yourself as a collaborator' });
      return;
    }

    const collaborator = await addCollaborator(drawingId, targetUserId, permission || 'view');
    if (!collaborator) {
      res.status(500).json({ error: 'Failed to add collaborator' });
      return;
    }
    // A changed permission applies to the collaborator's open socket immediately.
    await refreshRoomAccess(drawingId);

    res.status(201).json({
      collaborator: {
        userId: collaborator.user_id,
        username: collaborator.username,
        displayName: collaborator.display_name,
        permission: collaborator.permission,
      },
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to add collaborator');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove collaborator
router.delete('/:drawingId/collaborators/:targetUserId', requireAuth as never, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { drawingId, targetUserId } = req.params;
    const userId = req.session.userId!;

    const access = await hasAccess(drawingId, userId);
    if (!access.isOwner) {
      res.status(403).json({ error: 'Only the owner can manage collaborators' });
      return;
    }

    await removeCollaborator(drawingId, targetUserId);
    // Revocation reaches a socket that is already in the room, not just the next join.
    await refreshRoomAccess(drawingId);
    res.json({ message: 'Collaborator removed' });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to remove collaborator');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get collaborators
router.get('/:drawingId/collaborators', requireAuth as never, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { drawingId } = req.params;
    const access = await hasAccess(drawingId, req.session.userId!);
    if (!access.canView) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const collaborators = await getCollaborators(drawingId);

    res.json({
      collaborators: collaborators.map((c) => ({
        userId: c.user_id,
        username: c.username,
        displayName: c.display_name,
        permission: c.permission,
      })),
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to get collaborators');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
