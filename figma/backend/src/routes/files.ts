import { Router, Request, Response } from 'express';
import { fileService } from '../services/fileService.js';
import { getFileUserCount } from '../websocket/handler.js';
import { logger, withIdempotency, withRetry, dbRetryOptions } from '../shared/index.js';

/**
 * Express router for file management REST API endpoints.
 * Provides CRUD operations for design files and version management.
 * Includes idempotency support for create/update operations.
 */
const router = Router();

/**
 * GET /api/files
 * Retrieves all design files, ordered by most recently updated.
 */
// Get all files
router.get('/', async (_req: Request, res: Response) => {
  try {
    const files = await withRetry(
      () => fileService.getFiles(),
      { ...dbRetryOptions, operationName: 'getFiles' }
    );
    res.json(files);
  } catch (error) {
    logger.error({ error }, 'Error fetching files');
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
    const file = await withRetry(
      () => fileService.getFile(req.params.id),
      { ...dbRetryOptions, operationName: 'getFile' }
    );
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.json({
      ...file,
      activeUsers: getFileUserCount(file.id),
    });
  } catch (error) {
    logger.error({ error, fileId: req.params.id }, 'Error fetching file');
    res.status(500).json({ error: 'Failed to fetch file' });
  }
});

/**
 * POST /api/files
 * Creates a new design file with the given name.
 * Supports idempotency via X-Idempotency-Key header.
 */
// Create new file
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, projectId, teamId } = req.body;
    const idempotencyKey = req.headers['x-idempotency-key'] as string;

    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    // Use demo user for now
    const ownerId = '00000000-0000-0000-0000-000000000001';

    // Create file with optional idempotency
    const createFile = async () => {
      return await withRetry(
        () => fileService.createFile(name, ownerId, projectId, teamId),
        { ...dbRetryOptions, operationName: 'createFile' }
      );
    };

    let file;
    if (idempotencyKey) {
      file = await withIdempotency(`file:create:${idempotencyKey}`, createFile);
      logger.info({ idempotencyKey, fileId: file.id }, 'File created with idempotency');
    } else {
      file = await createFile();
      logger.info({ fileId: file.id }, 'File created');
    }

    res.status(201).json(file);
  } catch (error) {
    logger.error({ error }, 'Error creating file');
    res.status(500).json({ error: 'Failed to create file' });
  }
});

/**
 * PATCH /api/files/:id
 * Updates a file's name.
 * Supports idempotency via X-Idempotency-Key header.
 */
// Update file name
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    const idempotencyKey = req.headers['x-idempotency-key'] as string;

    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const updateFile = async () => {
      await withRetry(
        () => fileService.updateFileName(req.params.id, name),
        { ...dbRetryOptions, operationName: 'updateFileName' }
      );
      return await fileService.getFile(req.params.id);
    };

    let file;
    if (idempotencyKey) {
      file = await withIdempotency(`file:update:${req.params.id}:${idempotencyKey}`, updateFile);
    } else {
      file = await updateFile();
    }

    res.json(file);
  } catch (error) {
    logger.error({ error, fileId: req.params.id }, 'Error updating file');
    res.status(500).json({ error: 'Failed to update file' });
  }
});

/**
 * DELETE /api/files/:id
 * Soft-deletes a file (can be recovered within retention period).
 */
// Delete file
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await withRetry(
      () => fileService.softDeleteFile(req.params.id),
      { ...dbRetryOptions, operationName: 'deleteFile' }
    );
    logger.info({ fileId: req.params.id }, 'File soft-deleted');
    res.status(204).send();
  } catch (error) {
    logger.error({ error, fileId: req.params.id }, 'Error deleting file');
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
    const versions = await withRetry(
      () => fileService.getVersionHistory(req.params.id, limit),
      { ...dbRetryOptions, operationName: 'getVersionHistory' }
    );
    res.json(versions);
  } catch (error) {
    logger.error({ error, fileId: req.params.id }, 'Error fetching versions');
    res.status(500).json({ error: 'Failed to fetch versions' });
  }
});

/**
 * POST /api/files/:id/versions
 * Creates a named version snapshot of the current file state.
 * Supports idempotency via X-Idempotency-Key header.
 */
// Create named version
router.post('/:id/versions', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    const idempotencyKey = req.headers['x-idempotency-key'] as string;
    const userId = '00000000-0000-0000-0000-000000000001'; // Demo user

    const createVersion = async () => {
      return await withRetry(
        () => fileService.createVersion(req.params.id, userId, name, false),
        { ...dbRetryOptions, operationName: 'createVersion' }
      );
    };

    let version;
    if (idempotencyKey) {
      version = await withIdempotency(`version:create:${req.params.id}:${idempotencyKey}`, createVersion);
    } else {
      version = await createVersion();
    }

    res.status(201).json(version);
  } catch (error) {
    logger.error({ error, fileId: req.params.id }, 'Error creating version');
    res.status(500).json({ error: 'Failed to create version' });
  }
});

/**
 * POST /api/files/:id/versions/:versionId/restore
 * Restores a file to a previous version state.
 * Supports idempotency via X-Idempotency-Key header.
 */
// Restore version
router.post('/:id/versions/:versionId/restore', async (req: Request, res: Response) => {
  try {
    const userId = '00000000-0000-0000-0000-000000000001'; // Demo user
    const idempotencyKey = req.headers['x-idempotency-key'] as string;

    const restoreVersion = async () => {
      await withRetry(
        () => fileService.restoreVersion(req.params.id, req.params.versionId, userId),
        { ...dbRetryOptions, operationName: 'restoreVersion' }
      );
      return await fileService.getFile(req.params.id);
    };

    let file;
    if (idempotencyKey) {
      file = await withIdempotency(
        `version:restore:${req.params.id}:${req.params.versionId}:${idempotencyKey}`,
        restoreVersion
      );
    } else {
      file = await restoreVersion();
    }

    res.json(file);
  } catch (error) {
    logger.error({
      error,
      fileId: req.params.id,
      versionId: req.params.versionId,
    }, 'Error restoring version');
    res.status(500).json({ error: 'Failed to restore version' });
  }
});

export default router;
