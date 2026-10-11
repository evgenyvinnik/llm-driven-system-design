import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { deleteObject } from '../services/storageService.js';
import { requireVideoAccess, isUuid } from '../services/videoAccess.js';
import { mapVideoRow, withThumbnailUrls } from '../services/videoMapper.js';
import { abortUploadFor } from '../services/uploadService.js';

const router = Router();

// GET /api/videos - List user's videos with pagination
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId;
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const offset = (page - 1) * limit;
    const search = req.query.search as string;
    const folderId = req.query.folderId as string;

    let query: string;
    let countQuery: string;
    const params: (string | number)[] = [userId!];

    if (folderId) {
      if (!isUuid(folderId)) {
        res.json({ videos: [], total: 0, page, limit });
        return;
      }
      query = `SELECT v.* FROM videos v
               JOIN video_folders vf ON vf.video_id = v.id
               WHERE v.user_id = $1 AND vf.folder_id = $2`;
      countQuery = `SELECT COUNT(*) FROM videos v
                    JOIN video_folders vf ON vf.video_id = v.id
                    WHERE v.user_id = $1 AND vf.folder_id = $2`;
      params.push(folderId);
    } else {
      query = 'SELECT * FROM videos WHERE user_id = $1';
      countQuery = 'SELECT COUNT(*) FROM videos WHERE user_id = $1';
    }

    if (search) {
      const searchParam = `%${search}%`;
      query += ` AND (title ILIKE $${params.length + 1} OR description ILIKE $${params.length + 1})`;
      countQuery += ` AND (title ILIKE $${params.length + 1} OR description ILIKE $${params.length + 1})`;
      params.push(searchParam);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const [videosResult, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, params.slice(0, -2)),
    ]);

    res.json({
      videos: await withThumbnailUrls(videosResult.rows),
      total: parseInt(countResult.rows[0].count, 10),
      page,
      limit,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to list videos');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/videos/:id - Get single video (owner, or a viewer holding a share grant)
router.get('/:id', requireVideoAccess('viewer', 'id'), async (_req: Request, res: Response) => {
  try {
    const { video, role } = res.locals.videoAccess!;
    const author = await pool.query(
      'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
      [video.user_id],
    );
    const [mapped] = await withThumbnailUrls([video], role);
    const a = author.rows[0];
    res.json({
      video: {
        ...mapped,
        author: a
          ? { username: a.username, displayName: a.display_name, avatarUrl: a.avatar_url }
          : undefined,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get video');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/videos - Create video metadata (status 'uploading').
// The recorder sends its own UUID, so a retried create returns the same row instead of a duplicate.
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id, title, description } = req.body ?? {};
    const userId = req.session.userId;

    if (typeof title !== 'string' || title.trim().length === 0 || title.length > 255) {
      res.status(400).json({ error: 'Title is required (at most 255 characters)' });
      return;
    }
    if (id !== undefined && !isUuid(id)) {
      res.status(400).json({ error: 'id must be a UUID' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO videos (id, user_id, title, description, status)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, 'uploading')
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [id ?? null, userId, title.trim(), description || null],
    );

    if (result.rows.length === 0) {
      const existing = await pool.query('SELECT * FROM videos WHERE id = $1 AND user_id = $2', [
        id,
        userId,
      ]);
      if (existing.rows.length === 0) {
        res.status(409).json({ error: 'Video id already in use' });
        return;
      }
      res.status(200).json({ video: mapVideoRow(existing.rows[0]) });
      return;
    }

    res.status(201).json({ video: mapVideoRow(result.rows[0]) });
  } catch (err) {
    logger.error({ err }, 'Failed to create video');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/videos/:id - Update video
router.put('/:id', requireAuth, requireVideoAccess('owner', 'id'), async (req: Request, res: Response) => {
  try {
    const { title, description } = req.body ?? {};
    if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0 || title.length > 255)) {
      res.status(400).json({ error: 'Title must be 1-255 characters' });
      return;
    }

    const result = await pool.query(
      `UPDATE videos SET title = COALESCE($1, title), description = COALESCE($2, description), updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [typeof title === 'string' ? title.trim() : null, description ?? null, req.params.id],
    );

    res.json({ video: mapVideoRow(result.rows[0]) });
  } catch (err) {
    logger.error({ err }, 'Failed to update video');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/videos/:id - Delete video, its objects, and any upload still open
router.delete('/:id', requireAuth, requireVideoAccess('owner', 'id'), async (req: Request, res: Response) => {
  try {
    const video = res.locals.videoAccess!.video;

    // Delete the row first: once it's gone nothing can hand out URLs for the objects.
    await pool.query('DELETE FROM videos WHERE id = $1', [req.params.id]);

    if (video.status === 'uploading') {
      await abortUploadFor(video).catch((err) =>
        logger.warn({ err, videoId: video.id }, 'Failed to abort multipart upload'),
      );
    }
    const keys = new Set(
      [video.storage_path, video.source_path, video.thumbnail_path].filter(
        (key): key is string => typeof key === 'string' && key.length > 0,
      ),
    );
    for (const key of keys) {
      try {
        await deleteObject(key);
      } catch (storageErr) {
        // Orphaned objects are reclaimable later; a failed delete must not resurrect the row.
        logger.warn({ storageErr, path: key }, 'Failed to delete object from storage');
      }
    }

    res.json({ message: 'Video deleted' });
  } catch (err) {
    logger.error({ err }, 'Failed to delete video');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
