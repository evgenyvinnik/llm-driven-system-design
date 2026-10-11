import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { sharePasswordLimiter } from '../services/rateLimiter.js';
import {
  createShare,
  findShareByToken,
  checkSharePassword,
  type ShareRecord,
} from '../services/shareService.js';
import { issueGrant, readGrants } from '../services/shareGrants.js';
import { requireVideoAccess, isUuid } from '../services/videoAccess.js';
import { getPresignedDownloadUrl } from '../services/storageService.js';

const router = Router();

const PLAYABLE = new Set(['processing', 'ready']);

/** Loads the shared video and builds what the public share page renders. */
async function loadSharedVideo(share: ShareRecord) {
  const result = await pool.query(
    `SELECT v.*, u.username, u.display_name, u.avatar_url
     FROM videos v
     JOIN users u ON u.id = v.user_id
     WHERE v.id = $1`,
    [share.videoId],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

async function sharePayload(share: ShareRecord, row: Record<string, unknown>) {
  let downloadUrl: string | null = null;
  let thumbnailUrl: string | null = null;
  if (row.storage_path && PLAYABLE.has(row.status as string)) {
    downloadUrl = await getPresignedDownloadUrl(row.storage_path as string);
  }
  // The poster frame, so a shared link shows the recording rather than a
  // black rectangle before the viewer presses play.
  if (row.thumbnail_path) {
    thumbnailUrl = await getPresignedDownloadUrl(row.thumbnail_path as string);
  }
  return {
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
      allowDownload: share.allowDownload,
      author: {
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
      },
    },
  };
}

/** Shared lookup for both access endpoints; answers 404/410 itself and returns null. */
async function lookupOrRespond(req: Request, res: Response): Promise<ShareRecord | null> {
  const lookup = await findShareByToken(req.params.token);
  if (lookup.status === 'not_found') {
    res.status(404).json({ error: 'Share link not found' });
    return null;
  }
  if (lookup.status === 'expired') {
    res.status(410).json({ error: 'Share link has expired' });
    return null;
  }
  return lookup.share;
}

// POST /api/share/:videoId/share - Create a share link
router.post(
  '/:videoId/share',
  requireAuth,
  requireVideoAccess('owner'),
  async (req: Request, res: Response) => {
    try {
      const { videoId } = req.params;
      const { password, expiresAt, allowDownload } = req.body ?? {};

      if (password !== undefined && password !== null && password !== '') {
        if (typeof password !== 'string' || password.length > 128) {
          res.status(400).json({ error: 'Password must be a string of at most 128 characters' });
          return;
        }
      }
      let expiry: Date | null = null;
      if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
        expiry = new Date(expiresAt);
        if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
          res.status(400).json({ error: 'expiresAt must be a future date' });
          return;
        }
      }

      const share = await createShare(videoId, {
        password: password || undefined,
        expiresAt: expiry,
        allowDownload: allowDownload === true,
      });

      res.status(201).json({ share });
    } catch (err) {
      logger.error({ err }, 'Failed to create share');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// GET /api/share/:token - Open a share link (no password, or already unlocked in this browser)
router.get('/:token', async (req: Request, res: Response) => {
  try {
    const share = await lookupOrRespond(req, res);
    if (!share) return;

    const row = await loadSharedVideo(share);
    if (!row) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const isOwner = Boolean(req.session?.userId) && row.user_id === req.session.userId;
    const unlocked = readGrants(req).some((g) => g.s === share.id);
    if (share.passwordHash && !unlocked && !isOwner) {
      res.status(401).json({ error: 'Password required', requiresPassword: true });
      return;
    }

    issueGrant(req, res, share);
    res.json(await sharePayload(share, row));
  } catch (err) {
    logger.error({ err }, 'Failed to open share');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/share/:token/unlock - Check a share password once, then remember it in a signed cookie
router.post('/:token/unlock', sharePasswordLimiter, async (req: Request, res: Response) => {
  try {
    const share = await lookupOrRespond(req, res);
    if (!share) return;

    if (!(await checkSharePassword(share, req.body?.password))) {
      res.status(401).json({ error: 'Invalid password', requiresPassword: true });
      return;
    }

    const row = await loadSharedVideo(share);
    if (!row) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    issueGrant(req, res, share);
    res.json(await sharePayload(share, row));
  } catch (err) {
    logger.error({ err }, 'Failed to unlock share');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/share/:videoId/shares - List shares for a video
router.get(
  '/:videoId/shares',
  requireAuth,
  requireVideoAccess('owner'),
  async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT id, token, password_hash IS NOT NULL as has_password, expires_at, allow_download, created_at
         FROM shares WHERE video_id = $1 ORDER BY created_at DESC`,
        [req.params.videoId],
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
  },
);

// DELETE /api/share/:videoId/shares/:shareId - Revoke a share; every grant for it stops working
router.delete(
  '/:videoId/shares/:shareId',
  requireAuth,
  requireVideoAccess('owner'),
  async (req: Request, res: Response) => {
    try {
      const { videoId, shareId } = req.params;
      if (!isUuid(shareId)) {
        res.status(404).json({ error: 'Share not found' });
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
  },
);

export default router;
