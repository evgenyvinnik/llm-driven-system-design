import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireChannelAccess } from '../middleware/access.js';
import { canReadChannel, getChannelAccess, isUuid } from '../services/access.js';
import { logger } from '../services/logger.js';
import { uploadFile, getPresignedUrl } from '../services/storageService.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// POST /api/files - upload file. channelId arrives as a multipart field, so the access check runs
// after multer has parsed (and buffered) the body; the 50 MB cap bounds what that costs.
router.post(
  '/',
  requireAuth,
  upload.single('file'),
  requireChannelAccess((req) => req.body?.channelId),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const channelId = req.channelAccess!.channelId;
      const messageId = req.body.messageId || null;

      if (messageId) {
        // An attachment may only point at a message in the same channel.
        const owner = await pool.query('SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2', [
          isUuid(messageId) ? messageId : null,
          channelId,
        ]);
        if (owner.rows.length === 0) {
          res.status(400).json({ error: 'messageId must belong to this channel' });
          return;
        }
      }

      const fileId = uuidv4();
      // Keep only a short alphanumeric extension; the original name is stored separately.
      const ext =
        path.extname(req.file.originalname).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) ||
        'bin';
      const storagePath = `channels/${channelId}/${fileId}.${ext}`;

      await uploadFile(storagePath, req.file.buffer, req.file.mimetype);

      const result = await pool.query(
        `INSERT INTO files (message_id, channel_id, user_id, filename, content_type, size_bytes, storage_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          messageId,
          channelId,
          req.session.userId,
          req.file.originalname,
          req.file.mimetype,
          req.file.size,
          storagePath,
        ],
      );

      res.status(201).json({ file: result.rows[0] });
    } catch (err) {
      logger.error({ err }, 'Failed to upload file');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// GET /api/files/:fileId/download - get download URL
router.get('/:fileId/download', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = isUuid(req.params.fileId)
      ? await pool.query('SELECT * FROM files WHERE id = $1', [req.params.fileId])
      : { rows: [] };
    const file = result.rows[0];
    // A file is readable exactly when its channel is.
    const access = file ? await getChannelAccess(req.session.userId!, file.channel_id) : null;

    if (!access || !canReadChannel(access)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const url = await getPresignedUrl(file.storage_path);

    res.json({ url, file });
  } catch (err) {
    logger.error({ err }, 'Failed to get file download URL');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/files?channelId=xxx - list channel files
router.get(
  '/',
  requireAuth,
  requireChannelAccess((req) => req.query.channelId),
  async (req: Request, res: Response) => {
    try {
      const channelId = req.channelAccess!.channelId;

      const result = await pool.query(
        `SELECT f.*, u.username, u.display_name
         FROM files f
         JOIN users u ON f.user_id = u.id
         WHERE f.channel_id = $1
         ORDER BY f.created_at DESC`,
        [channelId],
      );

      res.json({ files: result.rows });
    } catch (err) {
      logger.error({ err }, 'Failed to list files');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
