/**
 * File and folder sharing routes.
 * Supports shared links (public URLs) and folder shares (user-specific).
 * Shared links work without auth; management routes require auth.
 * @module routes/sharing
 */

import { Router, Request, Response } from 'express';
import {
  createSharedLink,
  validateSharedLink,
  incrementDownloadCount,
  getUserSharedLinks,
  deleteSharedLink,
  shareFolderWithUser,
  getSharedWithMe,
  getFolderShares,
  removeFolderShare,
} from '../services/sharingService.js';
import { downloadFile, getFileChunks } from '../services/file/index.js';
import { authMiddleware, optionalAuthMiddleware, AuthRequest } from '../middleware/auth.js';
import { getDownloadPresignedUrl } from '../utils/storage.js';
import { queryOne } from '../utils/database.js';
import { FileItem } from '../types/index.js';

const router = Router();

/**
 * POST /api/share/link - Create a shared link for a file.
 * Requires auth. Body: { fileId, accessLevel?, password?, expiresInHours?, maxDownloads? }
 */
router.post('/link', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { fileId, accessLevel, password, expiresInHours, maxDownloads } = req.body;

    if (!fileId) {
      res.status(400).json({ error: 'fileId is required' });
      return;
    }

    const link = await createSharedLink(req.user!.id, fileId, {
      accessLevel,
      password,
      expiresInHours,
      maxDownloads,
    });

    res.status(201).json({
      ...link,
      url: `${req.protocol}://${req.get('host')}/api/share/${link.urlToken}`,
    });
  } catch (error) {
    console.error('Create share link error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/share/links - Get all shared links created by the current user.
 */
router.get('/links', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const links = await getUserSharedLinks(req.user!.id);
    res.json(links);
  } catch (error) {
    console.error('Get share links error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /api/share/link/:linkId - Delete a shared link.
 */
router.delete('/link/:linkId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await deleteSharedLink(req.user!.id, req.params.linkId as string);
    res.json({ message: 'Link deleted' });
  } catch (error) {
    console.error('Delete share link error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/share/:token - Access a shared link and get file info.
 * Query: password (if link is password-protected)
 */
router.get('/:token', optionalAuthMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { password } = req.query;
    const result = await validateSharedLink(req.params.token as string, password as string | undefined);

    if (!result.valid) {
      res.status(result.error === 'Password required' ? 401 : 400).json({
        error: result.error,
        requiresPassword: result.error === 'Password required',
      });
      return;
    }

    res.json({ file: result.file });
  } catch (error) {
    console.error('Access share link error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/share/:token/download - Download a file via shared link.
 * Query: password (if required). Increments download counter.
 */
router.get('/:token/download', optionalAuthMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { password } = req.query;
    const result = await validateSharedLink(req.params.token as string, password as string | undefined);

    if (!result.valid || !result.file) {
      res.status(400).json({ error: result.error });
      return;
    }

    // Get file owner's ID to download
    const file = await queryOne<FileItem>(
      `SELECT user_id as "userId" FROM files WHERE id = $1`,
      [result.file.id]
    );

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Get chunks and download
    const chunks = await getFileChunks(result.file.id);
    const chunkBuffers: Buffer[] = [];

    for (const chunk of chunks) {
      const { downloadChunk } = await import('../utils/storage.js');
      const data = await downloadChunk(chunk.chunkHash);
      chunkBuffers.push(data);
    }

    const data = Buffer.concat(chunkBuffers);

    // Increment download count
    await incrementDownloadCount(req.params.token as string);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.file.name)}"`);
    res.setHeader('Content-Type', result.file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', data.length);

    res.send(data);
  } catch (error) {
    console.error('Download share error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/share/folder - Share a folder with another user.
 * Body: { folderId, email, accessLevel: 'view' | 'edit' }
 */
router.post('/folder', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { folderId, email, accessLevel } = req.body;

    if (!folderId || !email || !accessLevel) {
      res.status(400).json({ error: 'folderId, email, and accessLevel are required' });
      return;
    }

    if (!['view', 'edit'].includes(accessLevel)) {
      res.status(400).json({ error: 'accessLevel must be view or edit' });
      return;
    }

    const share = await shareFolderWithUser(req.user!.id, folderId, email, accessLevel);
    res.status(201).json(share);
  } catch (error) {
    console.error('Share folder error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/share/shared-with-me - Get folders shared with the current user.
 */
router.get('/shared-with-me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const folders = await getSharedWithMe(req.user!.id);
    res.json(folders);
  } catch (error) {
    console.error('Get shared with me error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/share/folder/:folderId - Get users a folder is shared with.
 */
router.get('/folder/:folderId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const shares = await getFolderShares(req.user!.id, req.params.folderId as string);
    res.json(shares);
  } catch (error) {
    console.error('Get folder shares error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /api/share/folder/:folderId/:userId - Remove a user from a folder share.
 */
router.delete('/folder/:folderId/:userId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await removeFolderShare(req.user!.id, req.params.folderId as string, req.params.userId as string);
    res.json({ message: 'Share removed' });
  } catch (error) {
    console.error('Remove folder share error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

export default router;
