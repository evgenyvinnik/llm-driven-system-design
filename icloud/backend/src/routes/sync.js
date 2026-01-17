import { Router } from 'express';
import { pool, redis } from '../db.js';
import { SyncService } from '../services/sync.js';
import { broadcastToUser } from '../services/websocket.js';

const router = Router();
const syncService = new SyncService();

// Get sync state for device
router.get('/state', async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = req.deviceId;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID required for sync' });
    }

    // Get device sync state
    const deviceState = await pool.query(
      `SELECT last_sync_at, sync_cursor
       FROM devices
       WHERE id = $1 AND user_id = $2`,
      [deviceId, userId]
    );

    if (deviceState.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const state = deviceState.rows[0];

    res.json({
      deviceId,
      lastSyncAt: state.last_sync_at,
      syncCursor: state.sync_cursor,
    });
  } catch (error) {
    console.error('Get sync state error:', error);
    res.status(500).json({ error: 'Failed to get sync state' });
  }
});

// Get changes since last sync
router.get('/changes', async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = req.deviceId;
    const { since } = req.query;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID required for sync' });
    }

    const sinceDate = since ? new Date(since) : new Date(0);

    // Get files modified since last sync (excluding this device's changes)
    const changes = await pool.query(
      `SELECT id, name, path, mime_type, size, content_hash, version_vector,
              is_folder, is_deleted, modified_at, last_modified_by
       FROM files
       WHERE user_id = $1
         AND modified_at > $2
         AND (last_modified_by IS NULL OR last_modified_by != $3)
       ORDER BY modified_at ASC
       LIMIT 1000`,
      [userId, sinceDate, deviceId]
    );

    // Group by operation type
    const created = [];
    const updated = [];
    const deleted = [];

    for (const file of changes.rows) {
      const fileData = {
        id: file.id,
        name: file.name,
        path: file.path,
        mimeType: file.mime_type,
        size: file.size,
        contentHash: file.content_hash,
        versionVector: file.version_vector,
        isFolder: file.is_folder,
        modifiedAt: file.modified_at,
      };

      if (file.is_deleted) {
        deleted.push(fileData);
      } else if (file.created_at === file.modified_at) {
        created.push(fileData);
      } else {
        updated.push(fileData);
      }
    }

    // Generate new sync cursor
    const newCursor = changes.rows.length > 0
      ? changes.rows[changes.rows.length - 1].modified_at.toISOString()
      : sinceDate.toISOString();

    res.json({
      changes: { created, updated, deleted },
      cursor: newCursor,
      hasMore: changes.rows.length === 1000,
    });
  } catch (error) {
    console.error('Get changes error:', error);
    res.status(500).json({ error: 'Failed to get changes' });
  }
});

// Push local changes to server
router.post('/push', async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = req.deviceId;
    const { changes } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID required for sync' });
    }

    if (!changes || !Array.isArray(changes)) {
      return res.status(400).json({ error: 'Changes array required' });
    }

    const results = {
      applied: [],
      conflicts: [],
      errors: [],
    };

    for (const change of changes) {
      try {
        const result = await syncService.applyChange(userId, deviceId, change);

        if (result.conflict) {
          results.conflicts.push({
            fileId: change.fileId,
            localVersion: change.versionVector,
            serverVersion: result.serverVersion,
            conflictType: result.conflictType,
          });
        } else {
          results.applied.push({
            fileId: change.fileId,
            newVersion: result.versionVector,
          });

          // Notify other devices
          broadcastToUser(userId, {
            type: `file_${change.operation}`,
            file: result.file,
            sourceDevice: deviceId,
          });
        }
      } catch (error) {
        results.errors.push({
          fileId: change.fileId,
          error: error.message,
        });
      }
    }

    // Update device sync state
    await pool.query(
      `UPDATE devices
       SET last_sync_at = NOW(), sync_cursor = $1
       WHERE id = $2`,
      [JSON.stringify({ lastPush: new Date().toISOString() }), deviceId]
    );

    res.json(results);
  } catch (error) {
    console.error('Push changes error:', error);
    res.status(500).json({ error: 'Failed to push changes' });
  }
});

// Resolve conflict
router.post('/resolve-conflict', async (req, res) => {
  try {
    const userId = req.user.id;
    const deviceId = req.deviceId;
    const { fileId, resolution, keepBoth } = req.body;

    if (!fileId || !resolution) {
      return res.status(400).json({ error: 'fileId and resolution required' });
    }

    const result = await syncService.resolveConflict(
      userId,
      deviceId,
      fileId,
      resolution,
      keepBoth
    );

    // Notify all devices
    broadcastToUser(userId, {
      type: 'conflict_resolved',
      fileId,
      resolution,
    });

    res.json(result);
  } catch (error) {
    console.error('Resolve conflict error:', error);
    res.status(500).json({ error: 'Failed to resolve conflict' });
  }
});

// Get pending conflicts
router.get('/conflicts', async (req, res) => {
  try {
    const userId = req.user.id;

    const conflicts = await pool.query(
      `SELECT fv.*, f.name, f.path, d.name as device_name
       FROM file_versions fv
       JOIN files f ON fv.file_id = f.id
       LEFT JOIN devices d ON fv.created_by = d.id
       WHERE f.user_id = $1
         AND fv.is_conflict = TRUE
         AND fv.conflict_resolved = FALSE
       ORDER BY fv.created_at DESC`,
      [userId]
    );

    res.json({
      conflicts: conflicts.rows.map(c => ({
        id: c.id,
        fileId: c.file_id,
        fileName: c.name,
        filePath: c.path,
        versionNumber: c.version_number,
        contentHash: c.content_hash,
        versionVector: c.version_vector,
        deviceName: c.device_name,
        createdAt: c.created_at,
      })),
    });
  } catch (error) {
    console.error('Get conflicts error:', error);
    res.status(500).json({ error: 'Failed to get conflicts' });
  }
});

// Delta sync - get only changed chunks
router.post('/delta', async (req, res) => {
  try {
    const userId = req.user.id;
    const { fileId, localChunkHashes } = req.body;

    if (!fileId || !Array.isArray(localChunkHashes)) {
      return res.status(400).json({ error: 'fileId and localChunkHashes required' });
    }

    // Verify file belongs to user
    const file = await pool.query(
      'SELECT id FROM files WHERE id = $1 AND user_id = $2',
      [fileId, userId]
    );

    if (file.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Get server chunks
    const serverChunks = await pool.query(
      `SELECT chunk_index, chunk_hash, chunk_size
       FROM file_chunks
       WHERE file_id = $1
       ORDER BY chunk_index`,
      [fileId]
    );

    const localHashSet = new Set(localChunkHashes);
    const chunksToDownload = [];
    const chunksToKeep = [];

    for (const chunk of serverChunks.rows) {
      if (localHashSet.has(chunk.chunk_hash)) {
        chunksToKeep.push({
          index: chunk.chunk_index,
          hash: chunk.chunk_hash,
        });
      } else {
        chunksToDownload.push({
          index: chunk.chunk_index,
          hash: chunk.chunk_hash,
          size: chunk.chunk_size,
        });
      }
    }

    res.json({
      fileId,
      totalChunks: serverChunks.rows.length,
      chunksToDownload,
      chunksToKeep,
      bytesToDownload: chunksToDownload.reduce((sum, c) => sum + c.size, 0),
    });
  } catch (error) {
    console.error('Delta sync error:', error);
    res.status(500).json({ error: 'Failed to compute delta' });
  }
});

// Download a specific chunk
router.get('/chunk/:chunkHash', async (req, res) => {
  try {
    const { chunkHash } = req.params;
    const userId = req.user.id;

    // Verify user has access to this chunk
    const access = await pool.query(
      `SELECT fc.storage_key
       FROM file_chunks fc
       JOIN files f ON fc.file_id = f.id
       WHERE fc.chunk_hash = $1 AND f.user_id = $2
       LIMIT 1`,
      [chunkHash, userId]
    );

    if (access.rows.length === 0) {
      return res.status(404).json({ error: 'Chunk not found' });
    }

    // Get chunk from service
    const { ChunkService } = await import('../services/chunks.js');
    const chunkService = new ChunkService();
    const chunkData = await chunkService.downloadChunk(chunkHash);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', chunkData.length);
    res.setHeader('X-Chunk-Hash', chunkHash);
    res.send(chunkData);
  } catch (error) {
    console.error('Download chunk error:', error);
    res.status(500).json({ error: 'Failed to download chunk' });
  }
});

export default router;
