import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import crypto from 'crypto';
import { pool, redis, minioClient } from '../db.js';
import { ChunkService } from '../services/chunks.js';
import { broadcastToUser } from '../services/websocket.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const chunkService = new ChunkService();

// List files in a folder
router.get('/', async (req, res) => {
  try {
    const { path = '/', includeDeleted = 'false' } = req.query;
    const userId = req.user.id;

    let query = `
      SELECT id, name, path, mime_type, size, content_hash, version_vector,
             is_folder, is_deleted, created_at, modified_at
      FROM files
      WHERE user_id = $1 AND path LIKE $2
    `;

    const params = [userId, path === '/' ? '/%' : `${path}/%`];

    if (includeDeleted !== 'true') {
      query += ' AND is_deleted = FALSE';
    }

    // Only get direct children (not nested)
    query += ` AND path NOT LIKE $3`;
    const nestedPattern = path === '/' ? '/%/%' : `${path}/%/%`;
    params.push(nestedPattern);

    query += ' ORDER BY is_folder DESC, name ASC';

    const result = await pool.query(query, params);

    res.json({
      path,
      files: result.rows.map(f => ({
        id: f.id,
        name: f.name,
        path: f.path,
        mimeType: f.mime_type,
        size: f.size,
        contentHash: f.content_hash,
        versionVector: f.version_vector,
        isFolder: f.is_folder,
        isDeleted: f.is_deleted,
        createdAt: f.created_at,
        modifiedAt: f.modified_at,
      })),
    });
  } catch (error) {
    console.error('List files error:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// Get file metadata
router.get('/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT f.*, array_agg(fc.chunk_hash ORDER BY fc.chunk_index) as chunks
       FROM files f
       LEFT JOIN file_chunks fc ON f.id = fc.file_id
       WHERE f.id = $1 AND f.user_id = $2
       GROUP BY f.id`,
      [fileId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = result.rows[0];

    res.json({
      id: file.id,
      name: file.name,
      path: file.path,
      mimeType: file.mime_type,
      size: file.size,
      contentHash: file.content_hash,
      versionVector: file.version_vector,
      isFolder: file.is_folder,
      isDeleted: file.is_deleted,
      chunks: file.chunks.filter(c => c !== null),
      createdAt: file.created_at,
      modifiedAt: file.modified_at,
    });
  } catch (error) {
    console.error('Get file error:', error);
    res.status(500).json({ error: 'Failed to get file' });
  }
});

// Create folder
router.post('/folder', async (req, res) => {
  try {
    const { name, parentPath = '/' } = req.body;
    const userId = req.user.id;
    const deviceId = req.deviceId;

    if (!name) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;

    // Check if folder already exists
    const existing = await pool.query(
      `SELECT id FROM files WHERE user_id = $1 AND path = $2 AND is_deleted = FALSE`,
      [userId, path]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Folder already exists' });
    }

    // Initialize version vector
    const versionVector = deviceId ? { [deviceId]: 1 } : {};

    const result = await pool.query(
      `INSERT INTO files (user_id, name, path, is_folder, version_vector, last_modified_by)
       VALUES ($1, $2, $3, TRUE, $4, $5)
       RETURNING id, name, path, is_folder, version_vector, created_at, modified_at`,
      [userId, name, path, JSON.stringify(versionVector), deviceId]
    );

    const folder = result.rows[0];

    // Notify other devices
    broadcastToUser(userId, {
      type: 'file_created',
      file: folder,
    });

    res.status(201).json({
      id: folder.id,
      name: folder.name,
      path: folder.path,
      isFolder: folder.is_folder,
      versionVector: folder.version_vector,
      createdAt: folder.created_at,
      modifiedAt: folder.modified_at,
    });
  } catch (error) {
    console.error('Create folder error:', error);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// Upload file (small files - direct upload)
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { parentPath = '/', fileName } = req.body;
    const userId = req.user.id;
    const deviceId = req.deviceId;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const name = fileName || file.originalname;
    const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;

    // Calculate content hash
    const contentHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

    // Check if file already exists
    const existing = await pool.query(
      `SELECT id, version_vector FROM files
       WHERE user_id = $1 AND path = $2 AND is_deleted = FALSE`,
      [userId, path]
    );

    // Get current version vector
    let versionVector = {};
    let fileId;
    let isUpdate = false;

    if (existing.rows.length > 0) {
      // Update existing file
      isUpdate = true;
      fileId = existing.rows[0].id;
      versionVector = existing.rows[0].version_vector || {};

      // Increment version for this device
      if (deviceId) {
        versionVector[deviceId] = (versionVector[deviceId] || 0) + 1;
      }

      await pool.query(
        `UPDATE files
         SET content_hash = $1, size = $2, mime_type = $3,
             version_vector = $4, modified_at = NOW(), last_modified_by = $5
         WHERE id = $6`,
        [contentHash, file.size, file.mimetype, JSON.stringify(versionVector), deviceId, fileId]
      );

      // Delete old chunks
      await pool.query('DELETE FROM file_chunks WHERE file_id = $1', [fileId]);
    } else {
      // Create new file
      versionVector = deviceId ? { [deviceId]: 1 } : {};

      const result = await pool.query(
        `INSERT INTO files (user_id, name, path, mime_type, size, content_hash, version_vector, last_modified_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [userId, name, path, file.mimetype, file.size, contentHash, JSON.stringify(versionVector), deviceId]
      );

      fileId = result.rows[0].id;
    }

    // Store file in chunks
    const chunks = await chunkService.storeFile(fileId, file.buffer);

    // Update user storage
    await pool.query(
      `UPDATE users SET storage_used = storage_used + $1 WHERE id = $2`,
      [file.size, userId]
    );

    // Log sync operation
    await pool.query(
      `INSERT INTO sync_operations (user_id, device_id, file_id, operation_type, status, completed_at)
       VALUES ($1, $2, $3, $4, 'completed', NOW())`,
      [userId, deviceId, fileId, isUpdate ? 'update' : 'create']
    );

    // Notify other devices
    broadcastToUser(userId, {
      type: isUpdate ? 'file_updated' : 'file_created',
      file: { id: fileId, path, name, size: file.size, contentHash, versionVector },
    });

    res.status(isUpdate ? 200 : 201).json({
      id: fileId,
      name,
      path,
      size: file.size,
      mimeType: file.mimetype,
      contentHash,
      versionVector,
      chunks: chunks.map(c => c.chunkHash),
    });
  } catch (error) {
    console.error('Upload file error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Download file
router.get('/:fileId/download', async (req, res) => {
  try {
    const { fileId } = req.params;
    const userId = req.user.id;

    // Get file metadata
    const fileResult = await pool.query(
      `SELECT id, name, mime_type, size, content_hash
       FROM files
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE AND is_folder = FALSE`,
      [fileId, userId]
    );

    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileResult.rows[0];

    // Get file chunks
    const chunksResult = await pool.query(
      `SELECT fc.chunk_hash, fc.chunk_index, cs.storage_key
       FROM file_chunks fc
       JOIN chunk_store cs ON fc.chunk_hash = cs.chunk_hash
       WHERE fc.file_id = $1
       ORDER BY fc.chunk_index`,
      [fileId]
    );

    // Assemble file from chunks
    const fileBuffer = await chunkService.assembleFile(chunksResult.rows);

    // Set response headers
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
    res.setHeader('Content-Length', fileBuffer.length);

    res.send(fileBuffer);
  } catch (error) {
    console.error('Download file error:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Delete file (soft delete)
router.delete('/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const userId = req.user.id;
    const deviceId = req.deviceId;

    // Get file info
    const fileResult = await pool.query(
      `SELECT id, name, path, size, is_folder, version_vector
       FROM files
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [fileId, userId]
    );

    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileResult.rows[0];
    const versionVector = file.version_vector || {};

    // Increment version for deletion
    if (deviceId) {
      versionVector[deviceId] = (versionVector[deviceId] || 0) + 1;
    }

    // Soft delete file
    await pool.query(
      `UPDATE files
       SET is_deleted = TRUE, version_vector = $1, modified_at = NOW(), last_modified_by = $2
       WHERE id = $3`,
      [JSON.stringify(versionVector), deviceId, fileId]
    );

    // If folder, soft delete all children
    if (file.is_folder) {
      await pool.query(
        `UPDATE files SET is_deleted = TRUE, modified_at = NOW()
         WHERE user_id = $1 AND path LIKE $2 AND is_deleted = FALSE`,
        [userId, `${file.path}/%`]
      );
    }

    // Update storage used
    await pool.query(
      `UPDATE users SET storage_used = storage_used - $1 WHERE id = $2`,
      [file.size, userId]
    );

    // Log sync operation
    await pool.query(
      `INSERT INTO sync_operations (user_id, device_id, file_id, operation_type, status, completed_at)
       VALUES ($1, $2, $3, 'delete', 'completed', NOW())`,
      [userId, deviceId, fileId]
    );

    // Notify other devices
    broadcastToUser(userId, {
      type: 'file_deleted',
      file: { id: fileId, path: file.path },
    });

    res.json({ message: 'File deleted', id: fileId });
  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Rename/move file
router.patch('/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { name, newPath } = req.body;
    const userId = req.user.id;
    const deviceId = req.deviceId;

    // Get current file
    const fileResult = await pool.query(
      `SELECT id, name, path, is_folder, version_vector
       FROM files WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [fileId, userId]
    );

    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileResult.rows[0];
    const versionVector = file.version_vector || {};

    // Increment version
    if (deviceId) {
      versionVector[deviceId] = (versionVector[deviceId] || 0) + 1;
    }

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (name) {
      updates.push(`name = $${paramIndex++}`);
      params.push(name);
    }

    if (newPath) {
      updates.push(`path = $${paramIndex++}`);
      params.push(newPath);
    }

    updates.push(`version_vector = $${paramIndex++}`);
    params.push(JSON.stringify(versionVector));

    updates.push(`modified_at = NOW()`);
    updates.push(`last_modified_by = $${paramIndex++}`);
    params.push(deviceId);

    params.push(fileId);

    await pool.query(
      `UPDATE files SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      params
    );

    // If folder was moved, update children paths
    if (file.is_folder && newPath) {
      const oldPathPrefix = file.path;
      await pool.query(
        `UPDATE files
         SET path = $1 || substring(path from $2)
         WHERE user_id = $3 AND path LIKE $4`,
        [newPath, oldPathPrefix.length + 1, userId, `${oldPathPrefix}/%`]
      );
    }

    // Log and notify
    await pool.query(
      `INSERT INTO sync_operations (user_id, device_id, file_id, operation_type, status, completed_at)
       VALUES ($1, $2, $3, 'update', 'completed', NOW())`,
      [userId, deviceId, fileId]
    );

    broadcastToUser(userId, {
      type: 'file_updated',
      file: { id: fileId, name, path: newPath || file.path },
    });

    res.json({
      id: fileId,
      name: name || file.name,
      path: newPath || file.path,
      versionVector,
    });
  } catch (error) {
    console.error('Update file error:', error);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

// Get file versions (for conflict resolution)
router.get('/:fileId/versions', async (req, res) => {
  try {
    const { fileId } = req.params;
    const userId = req.user.id;

    // Verify file belongs to user
    const fileResult = await pool.query(
      `SELECT id FROM files WHERE id = $1 AND user_id = $2`,
      [fileId, userId]
    );

    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const versions = await pool.query(
      `SELECT fv.*, d.name as device_name
       FROM file_versions fv
       LEFT JOIN devices d ON fv.created_by = d.id
       WHERE fv.file_id = $1
       ORDER BY fv.version_number DESC`,
      [fileId]
    );

    res.json({
      fileId,
      versions: versions.rows.map(v => ({
        id: v.id,
        versionNumber: v.version_number,
        contentHash: v.content_hash,
        versionVector: v.version_vector,
        deviceName: v.device_name,
        isConflict: v.is_conflict,
        conflictResolved: v.conflict_resolved,
        createdAt: v.created_at,
      })),
    });
  } catch (error) {
    console.error('Get versions error:', error);
    res.status(500).json({ error: 'Failed to get versions' });
  }
});

export default router;
