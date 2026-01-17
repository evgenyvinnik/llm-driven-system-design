import { Router, Request, Response } from 'express';
import { fileService } from '../services/fileService.js';
import { getFileUserCount } from '../websocket/handler.js';

/**
 * Express router for file management REST API endpoints.
 * Provides CRUD operations for design files and version management.
 */
const router = Router();

/**
 * GET /api/files
 * Retrieves all design files, ordered by most recently updated.
 */
// Get all files
router.get('/', async (_req: Request, res: Response) => {
  try {
    const files = await fileService.getFiles();
    res.json(files);
  } catch (error) {
    console.error('Error fetching files:', error);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

/**
 * GET /api/files/:id
 * Retrieves a single file by ID with active user count.
 */
// Get file by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const file = await fileService.getFile(req.params.id);
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.json({
      ...file,
      activeUsers: getFileUserCount(file.id),
    });
  } catch (error) {
    console.error('Error fetching file:', error);
    res.status(500).json({ error: 'Failed to fetch file' });
  }
});

/**
 * POST /api/files
 * Creates a new design file with the given name.
 */
// Create new file
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, projectId, teamId } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    // Use demo user for now
    const ownerId = '00000000-0000-0000-0000-000000000001';
    const file = await fileService.createFile(name, ownerId, projectId, teamId);
    res.status(201).json(file);
  } catch (error) {
    console.error('Error creating file:', error);
    res.status(500).json({ error: 'Failed to create file' });
  }
});

/**
 * PATCH /api/files/:id
 * Updates a file's name.
 */
// Update file name
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    await fileService.updateFileName(req.params.id, name);
    const file = await fileService.getFile(req.params.id);
    res.json(file);
  } catch (error) {
    console.error('Error updating file:', error);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

/**
 * DELETE /api/files/:id
 * Permanently deletes a file.
 */
// Delete file
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await fileService.deleteFile(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

/**
 * GET /api/files/:id/versions
 * Retrieves version history for a file.
 */
// Get version history
router.get('/:id/versions', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const versions = await fileService.getVersionHistory(req.params.id, limit);
    res.json(versions);
  } catch (error) {
    console.error('Error fetching versions:', error);
    res.status(500).json({ error: 'Failed to fetch versions' });
  }
});

/**
 * POST /api/files/:id/versions
 * Creates a named version snapshot of the current file state.
 */
// Create named version
router.post('/:id/versions', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    const userId = '00000000-0000-0000-0000-000000000001'; // Demo user

    const version = await fileService.createVersion(req.params.id, userId, name, false);
    res.status(201).json(version);
  } catch (error) {
    console.error('Error creating version:', error);
    res.status(500).json({ error: 'Failed to create version' });
  }
});

/**
 * POST /api/files/:id/versions/:versionId/restore
 * Restores a file to a previous version state.
 */
// Restore version
router.post('/:id/versions/:versionId/restore', async (req: Request, res: Response) => {
  try {
    const userId = '00000000-0000-0000-0000-000000000001'; // Demo user

    await fileService.restoreVersion(req.params.id, req.params.versionId, userId);
    const file = await fileService.getFile(req.params.id);
    res.json(file);
  } catch (error) {
    console.error('Error restoring version:', error);
    res.status(500).json({ error: 'Failed to restore version' });
  }
});

export default router;
