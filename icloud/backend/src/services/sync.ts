import { pool } from '../db.js';

export class SyncService {
  /**
   * Compare two version vectors
   * Returns: 'local-newer', 'server-newer', 'equal', or 'conflict'
   */
  compareVersions(localVersion, serverVersion) {
    let localNewer = false;
    let serverNewer = false;

    const allDevices = new Set([
      ...Object.keys(localVersion || {}),
      ...Object.keys(serverVersion || {}),
    ]);

    for (const device of allDevices) {
      const localSeq = (localVersion || {})[device] || 0;
      const serverSeq = (serverVersion || {})[device] || 0;

      if (localSeq > serverSeq) localNewer = true;
      if (serverSeq > localSeq) serverNewer = true;
    }

    if (localNewer && serverNewer) return 'conflict';
    if (localNewer) return 'local-newer';
    if (serverNewer) return 'server-newer';
    return 'equal';
  }

  /**
   * Merge version vectors (take max of each component)
   */
  mergeVersions(v1, v2) {
    const merged = { ...v1 };

    for (const [device, seq] of Object.entries(v2 || {})) {
      merged[device] = Math.max(merged[device] || 0, seq);
    }

    return merged;
  }

  /**
   * Apply a change from a device
   */
  async applyChange(userId, deviceId, change) {
    const { fileId, operation, path, name, contentHash, versionVector, data } = change;

    // Get current server state
    const serverFile = await pool.query(
      `SELECT id, version_vector, content_hash, is_deleted
       FROM files WHERE id = $1 AND user_id = $2`,
      [fileId, userId]
    );

    // Handle different operations
    switch (operation) {
      case 'create':
        return this.handleCreate(userId, deviceId, change);

      case 'update':
        if (serverFile.rows.length === 0) {
          // File doesn't exist, treat as create
          return this.handleCreate(userId, deviceId, change);
        }
        return this.handleUpdate(userId, deviceId, serverFile.rows[0], change);

      case 'delete':
        if (serverFile.rows.length === 0) {
          // Already deleted or doesn't exist
          return { applied: true, versionVector: {} };
        }
        return this.handleDelete(userId, deviceId, serverFile.rows[0], change);

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  /**
   * Handle file creation
   */
  async handleCreate(userId, deviceId, change) {
    const { path, name, contentHash, mimeType, size } = change;

    // Check if file already exists at path
    const existing = await pool.query(
      `SELECT id, version_vector FROM files
       WHERE user_id = $1 AND path = $2 AND is_deleted = FALSE`,
      [userId, path]
    );

    if (existing.rows.length > 0) {
      // File exists, this is actually an update
      return this.handleUpdate(userId, deviceId, existing.rows[0], change);
    }

    // Create version vector
    const versionVector = { [deviceId]: 1 };

    const result = await pool.query(
      `INSERT INTO files (user_id, name, path, mime_type, size, content_hash,
                          version_vector, last_modified_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, path, version_vector, modified_at`,
      [userId, name, path, mimeType, size || 0, contentHash,
       JSON.stringify(versionVector), deviceId]
    );

    const file = result.rows[0];

    // Create initial version record
    await pool.query(
      `INSERT INTO file_versions (file_id, version_number, content_hash, version_vector, created_by)
       VALUES ($1, 1, $2, $3, $4)`,
      [file.id, contentHash, JSON.stringify(versionVector), deviceId]
    );

    return {
      applied: true,
      versionVector,
      file: {
        id: file.id,
        name: file.name,
        path: file.path,
        versionVector,
        modifiedAt: file.modified_at,
      },
    };
  }

  /**
   * Handle file update with conflict detection
   */
  async handleUpdate(userId, deviceId, serverFile, change) {
    const { fileId, contentHash, versionVector: localVersion, size, mimeType } = change;
    const serverVersion = serverFile.version_vector || {};

    // Compare versions
    const comparison = this.compareVersions(localVersion, serverVersion);

    if (comparison === 'conflict') {
      // Create conflict version
      const versionNumber = await this.getNextVersionNumber(fileId);

      await pool.query(
        `INSERT INTO file_versions (file_id, version_number, content_hash, version_vector, created_by, is_conflict)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [fileId, versionNumber, contentHash, JSON.stringify(localVersion), deviceId]
      );

      return {
        conflict: true,
        conflictType: 'concurrent-edit',
        serverVersion,
        localVersion,
        file: { id: fileId },
      };
    }

    if (comparison === 'server-newer' || comparison === 'equal') {
      // No update needed
      return {
        applied: false,
        reason: 'server-has-newer-or-equal',
        versionVector: serverVersion,
      };
    }

    // Local is newer, apply update
    const mergedVersion = this.mergeVersions(localVersion, serverVersion);
    mergedVersion[deviceId] = (mergedVersion[deviceId] || 0) + 1;

    await pool.query(
      `UPDATE files
       SET content_hash = $1, size = $2, mime_type = $3,
           version_vector = $4, modified_at = NOW(), last_modified_by = $5
       WHERE id = $6`,
      [contentHash, size, mimeType, JSON.stringify(mergedVersion), deviceId, fileId]
    );

    // Record version
    const versionNumber = await this.getNextVersionNumber(fileId);
    await pool.query(
      `INSERT INTO file_versions (file_id, version_number, content_hash, version_vector, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [fileId, versionNumber, contentHash, JSON.stringify(mergedVersion), deviceId]
    );

    return {
      applied: true,
      versionVector: mergedVersion,
      file: {
        id: fileId,
        versionVector: mergedVersion,
      },
    };
  }

  /**
   * Handle file deletion
   */
  async handleDelete(userId, deviceId, serverFile, change) {
    const { fileId, versionVector: localVersion } = change;
    const serverVersion = serverFile.version_vector || {};

    // Check for conflicts
    const comparison = this.compareVersions(localVersion, serverVersion);

    if (comparison === 'conflict') {
      // Someone else modified the file - this is a delete conflict
      return {
        conflict: true,
        conflictType: 'delete-conflict',
        serverVersion,
      };
    }

    // Perform soft delete
    const mergedVersion = this.mergeVersions(localVersion, serverVersion);
    mergedVersion[deviceId] = (mergedVersion[deviceId] || 0) + 1;

    await pool.query(
      `UPDATE files
       SET is_deleted = TRUE, version_vector = $1, modified_at = NOW(), last_modified_by = $2
       WHERE id = $3`,
      [JSON.stringify(mergedVersion), deviceId, fileId]
    );

    return {
      applied: true,
      versionVector: mergedVersion,
      file: { id: fileId, deleted: true },
    };
  }

  /**
   * Resolve a conflict
   */
  async resolveConflict(userId, deviceId, fileId, resolution, keepBoth) {
    const file = await pool.query(
      `SELECT id, name, path, version_vector FROM files
       WHERE id = $1 AND user_id = $2`,
      [fileId, userId]
    );

    if (file.rows.length === 0) {
      throw new Error('File not found');
    }

    const currentFile = file.rows[0];

    if (keepBoth) {
      // Create conflict copy
      const conflictPath = this.generateConflictPath(currentFile.path, deviceId);

      await pool.query(
        `INSERT INTO files (user_id, name, path, mime_type, size, content_hash, version_vector, last_modified_by)
         SELECT user_id, $1, $2, mime_type, size, content_hash, version_vector, $3
         FROM files WHERE id = $4`,
        [
          this.generateConflictName(currentFile.name, deviceId),
          conflictPath,
          deviceId,
          fileId,
        ]
      );
    }

    // Mark conflict as resolved
    if (resolution === 'use-local') {
      // Client will upload the local version
      const newVersion = { ...currentFile.version_vector };
      newVersion[deviceId] = (newVersion[deviceId] || 0) + 1;

      await pool.query(
        `UPDATE files SET version_vector = $1, modified_at = NOW() WHERE id = $2`,
        [JSON.stringify(newVersion), fileId]
      );
    }

    // Mark all conflict versions as resolved
    await pool.query(
      `UPDATE file_versions
       SET conflict_resolved = TRUE
       WHERE file_id = $1 AND is_conflict = TRUE`,
      [fileId]
    );

    return { resolved: true, fileId };
  }

  /**
   * Get next version number for a file
   */
  async getNextVersionNumber(fileId) {
    const result = await pool.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 as next
       FROM file_versions WHERE file_id = $1`,
      [fileId]
    );
    return result.rows[0].next;
  }

  /**
   * Generate conflict file name
   */
  generateConflictName(originalName, deviceId) {
    const ext = originalName.includes('.')
      ? '.' + originalName.split('.').pop()
      : '';
    const base = ext
      ? originalName.slice(0, -(ext.length))
      : originalName;

    const timestamp = new Date().toISOString().split('T')[0];
    const shortDeviceId = deviceId.slice(0, 8);

    return `${base} (conflict ${timestamp} ${shortDeviceId})${ext}`;
  }

  /**
   * Generate conflict file path
   */
  generateConflictPath(originalPath, deviceId) {
    const parts = originalPath.split('/');
    const name = parts.pop();
    const conflictName = this.generateConflictName(name, deviceId);
    return [...parts, conflictName].join('/');
  }
}
