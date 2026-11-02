import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { uploadFile, getPresignedUrl, deleteFile } from '../services/storageService.js';
import {
  AccessError,
  isUuid,
  requireChannel,
  respondError,
} from '../services/accessService.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

const FILE_COLUMNS =
  'f.id, f.message_id, f.channel_id, f.user_id, f.filename, f.content_type, f.size_bytes::int AS size_bytes, f.created_at';

/** Extension for the object key: letters and digits only, so the key stays under channels/{id}/. */
function safeExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return '';
  const ext = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? `.${ext}` : '';
}

// POST /api/files - upload file
router.post('/', requireAuth, upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const { channelId, messageId } = req.body;

    if (!channelId) {
      res.status(400).json({ error: 'channelId is required' });
      return;
    }

    // Membership is checked before anything is written to object storage, so
    // a non-member can neither plant objects nor files rows in a channel.
    const channel = await requireChannel(channelId, req.session.userId!);

    if (messageId) {
      if (!isUuid(messageId)) throw new AccessError(400, 'messageId must be your message in this channel');
      const msg = await pool.query(
        'SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2 AND user_id = $3 AND deleted_at IS NULL',
        [messageId, channel.channelId, req.session.userId],
      );
      if (msg.rows.length === 0) {
        throw new AccessError(400, 'messageId must be your message in this channel');
      }
    }

    const fileId = uuidv4();
    const storagePath = `channels/${channel.channelId}/${fileId}${safeExtension(req.file.originalname)}`;

    await uploadFile(storagePath, req.file.buffer, req.file.mimetype);

    try {
      const result = await pool.query(
        `INSERT INTO files (id, message_id, channel_id, user_id, filename, content_type, size_bytes, storage_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, message_id, channel_id, user_id, filename, content_type, size_bytes::int AS size_bytes, created_at`,
        [
          fileId,
          messageId || null,
          channel.channelId,
          req.session.userId,
          req.file.originalname.slice(0, 255),
          req.file.mimetype,
          req.file.size,
          storagePath,
        ],
      );
      res.status(201).json({ file: result.rows[0] });
    } catch (err) {
      // Don't leave an object behind that no row points to.
      deleteFile(storagePath).catch((e) => logger.warn({ err: e, storagePath }, 'Orphan cleanup failed'));
      throw err;
    }
  } catch (err) {
    respondError(res, err, 'Failed to upload file');
  }
});

// GET /api/files/:fileId/download - get download URL
router.get('/:fileId/download', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.fileId)) throw new AccessError(404, 'File not found');
    const result = await pool.query('SELECT * FROM files WHERE id = $1', [req.params.fileId]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const file = result.rows[0];
    // A presigned URL is a bearer credential for the object, so it is only
    // minted for someone who can see the channel the file was shared in.
    try {
      await requireChannel(file.channel_id, req.session.userId!);
    } catch (err) {
      if (err instanceof AccessError) throw new AccessError(404, 'File not found');
      throw err;
    }
    const url = await getPresignedUrl(file.storage_path);

    res.json({
      url,
      file: {
        id: file.id,
        message_id: file.message_id,
        channel_id: file.channel_id,
        filename: file.filename,
        content_type: file.content_type,
        size_bytes: file.size_bytes === null ? null : Number(file.size_bytes),
        created_at: file.created_at,
      },
    });
  } catch (err) {
    respondError(res, err, 'Failed to get file download URL');
  }
});

// GET /api/files?channelId=xxx - list channel files
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { channelId } = req.query;

    if (!channelId) {
      res.status(400).json({ error: 'channelId query parameter is required' });
      return;
    }
    const channel = await requireChannel(channelId, req.session.userId!);

    const result = await pool.query(
      `SELECT ${FILE_COLUMNS}, u.username, u.display_name
       FROM files f
       JOIN users u ON f.user_id = u.id
       WHERE f.channel_id = $1
       ORDER BY f.created_at DESC`,
      [channel.channelId],
    );

    res.json({ files: result.rows });
  } catch (err) {
    respondError(res, err, 'Failed to list files');
  }
});

export default router;
