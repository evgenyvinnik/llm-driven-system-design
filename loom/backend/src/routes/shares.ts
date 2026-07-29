import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { createShare, validateShare } from '../services/shareService.js';
import { getPresignedDownloadUrl } from '../services/storageService.js';

const router = Router();

// POST /api/videos/:videoId/share - Create a share link
router.post('/:videoId/share', requireAuth, async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;
    const userId = req.session.userId;
    const { password, expiresAt, allowDownload } = req.body;

    // Verify ownership
    const video = await pool.query(
      'SELECT id FROM videos WHERE id = $1 AND user_id = $2',
      [videoId, userId],
    );
    if (video.rows.length === 0) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const share = await createShare(videoId, { password, expiresAt, allowDownload });

    res.status(201).json({ share });
  } catch (err) {
    logger.error({ err }, 'Failed to create share');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/share/:token - Validate share and get video
router.get('/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const password = req.query.password as string;

    const validation = await validateShare(token, password);

    if (!validation.valid) {
      const status = validation.error === 'Password required' ? 401 : 404;
      res.status(status).json({ error: validation.error, requiresPassword: validation.error === 'Password required' });
      return;
    }

    // Get full video info
    const video = await pool.query(
      `SELECT v.*, u.username, u.display_name, u.avatar_url
       FROM videos v
       JOIN users u ON u.id = v.user_id
       WHERE v.id = $1`,
      [validation.videoId],
    );

    if (video.rows.length === 0) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const row = video.rows[0];
    let downloadUrl: string | null = null;
    let thumbnailUrl: string | null = null;

    // Generate presigned download URL for playback
    if (row.storage_path && row.status === 'ready') {
      downloadUrl = await getPresignedDownloadUrl(row.storage_path);
    }
    // The poster frame, so a shared link shows the recording rather than a
    // black rectangle before the viewer presses play.
    if (row.thumbnail_path) {
      thumbnailUrl = await getPresignedDownloadUrl(row.thumbnail_path);
    }

    res.json({
      video: {
        id: row.id,
        title: row.title,
        description: row.description,
        durationSeconds: row.duration_seconds,
        status: row.status,
        viewCount: row.view_count,
        createdAt: row.created_at,
        downloadUrl,
        thumbnailUrl,
        allowDownload: validation.allowDownload,
        author: {
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
        },
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to validate share');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/videos/:videoId/shares - List shares for a video
router.get('/:videoId/shares', requireAuth, async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;
    const userId = req.session.userId;

    // Verify ownership
    const video = await pool.query(
      'SELECT id FROM videos WHERE id = $1 AND user_id = $2',
      [videoId, userId],
    );
    if (video.rows.length === 0) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const result = await pool.query(
      `SELECT id, token, password_hash IS NOT NULL as has_password, expires_at, allow_download, created_at
       FROM shares WHERE video_id = $1 ORDER BY created_at DESC`,
      [videoId],
    );

    res.json({
      shares: result.rows.map((row) => ({
        id: row.id,
        token: row.token,
        hasPassword: row.has_password,
        expiresAt: row.expires_at,
        allowDownload: row.allow_download,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to list shares');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/videos/:videoId/shares/:shareId - Delete a share
router.delete('/:videoId/shares/:shareId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { videoId, shareId } = req.params;
    const userId = req.session.userId;

    // Verify ownership
    const video = await pool.query(
      'SELECT id FROM videos WHERE id = $1 AND user_id = $2',
      [videoId, userId],
    );
    if (video.rows.length === 0) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const result = await pool.query(
      'DELETE FROM shares WHERE id = $1 AND video_id = $2 RETURNING id',
      [shareId, videoId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Share not found' });
      return;
    }

    res.json({ message: 'Share deleted' });
  } catch (err) {
    logger.error({ err }, 'Failed to delete share');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
