/**
 * File and folder management service.
 * Handles file uploads with chunking and deduplication, folder operations,
 * file versioning, and storage hierarchy navigation.
 *
 * Features:
 * - Chunked uploads with deduplication
 * - File versioning with restore capability
 * - Prometheus metrics for all operations
 * - Structured logging for observability
 *
 * WHY sync metrics enable client optimization:
 * - Clients can measure actual sync latency vs. perceived latency
 * - Server-side metrics reveal bottlenecks in the sync pipeline
 * - Deduplication metrics inform storage efficiency decisions
 * - Upload/download metrics help tune chunk sizes and parallelism
 *
 * @module services/fileService
 */

import { query, queryOne, transaction } from '../utils/database.js';
import { FileItem, FileChunk, Chunk, UploadSession, FileVersion } from '../types/index.js';
import { uploadChunk, chunkExists, downloadChunk, BUCKET_NAME } from '../utils/storage.js';
import { calculateHash, calculateContentHash, CHUNK_SIZE, getMimeType } from '../utils/chunking.js';
import { publishSync, deleteCache } from '../utils/redis.js';
import { v4 as uuidv4 } from 'uuid';
import { logger, logFileOperation } from '../shared/logger.js';
import {
  uploadSessionsTotal,
  uploadSessionsActive,
  fileOperationsTotal,
  folderOperationsTotal,
  fileDownloadsTotal,
  syncEventsTotal,
  storageUsedBytes,
} from '../shared/metrics.js';

/**
 * Creates a new upload session for chunked file uploads.
 * Checks which chunks already exist in storage for deduplication,
 * allowing clients to skip uploading duplicate chunks.
 * @param userId - ID of uploading user
 * @param fileName - Name for the uploaded file
 * @param fileSize - Total file size in bytes
 * @param parentId - ID of parent folder (null for root)
 * @param chunkHashes - Array of SHA-256 hashes for all chunks
 * @returns Upload session ID, list of chunks that need uploading, and total chunk count
 */
export async function createUploadSession(
  userId: string,
  fileName: string,
  fileSize: number,
  parentId: string | null,
  chunkHashes: string[]
): Promise<{ uploadSessionId: string; chunksNeeded: string[]; totalChunks: number }> {
  const startTime = Date.now();

  try {
    // Check which chunks already exist (deduplication)
    const existingChunks = await query<{ hash: string }>(
      `SELECT hash FROM chunks WHERE hash = ANY($1)`,
      [chunkHashes]
    );

    const existingHashes = new Set(existingChunks.map((c) => c.hash));
    const chunksNeeded = chunkHashes.filter((h) => !existingHashes.has(h));

    // Create upload session
    const sessionId = uuidv4();
    await query(
      `INSERT INTO upload_sessions (id, user_id, file_name, file_size, parent_id, total_chunks, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [sessionId, userId, fileName, fileSize, parentId, chunkHashes.length]
    );

    // Update metrics
    uploadSessionsTotal.labels('created').inc();
    uploadSessionsActive.inc();

    logger.info(
      {
        userId,
        uploadSessionId: sessionId,
        fileName,
        fileSize,
        totalChunks: chunkHashes.length,
        chunksNeeded: chunksNeeded.length,
        chunksDeduped: existingHashes.size,
        durationMs: Date.now() - startTime,
      },
      'Upload session created'
    );

    return {
      uploadSessionId: sessionId,
      chunksNeeded,
      totalChunks: chunkHashes.length,
    };
  } catch (error) {
    uploadSessionsTotal.labels('failed').inc();
    logger.error(
      { userId, fileName, error: (error as Error).message },
      'Failed to create upload session'
    );
    throw error;
  }
}

/**
 * Uploads a single chunk of a file.
 * Verifies the chunk hash matches the data for integrity.
 * Increments reference count for existing chunks (deduplication).
 *
 * WHY idempotency enables reliable chunked uploads:
 * - Network failures are common during large uploads
 * - Clients may not receive confirmation even when upload succeeded
 * - Retry with same chunk hash is safe - content-addressed storage is idempotent
 * - Reference counts are updated correctly even with retries
 *
 * @param userId - ID of uploading user
 * @param uploadSessionId - Active upload session ID
 * @param chunkIndex - Position of this chunk in the file
 * @param chunkHash - Expected SHA-256 hash of the chunk
 * @param data - Raw chunk data
 * @returns Upload confirmation
 * @throws Error if session not found or hash mismatch
 */
export async function uploadFileChunk(
  userId: string,
  uploadSessionId: string,
  chunkIndex: number,
  chunkHash: string,
  data: Buffer
): Promise<{ uploaded: boolean }> {
  const startTime = Date.now();

  // Verify upload session
  const session = await queryOne<UploadSession>(
    `SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2`,
    [uploadSessionId, userId]
  );

  if (!session) {
    throw new Error('Upload session not found');
  }

  // Calculate hash and verify
  const actualHash = calculateHash(data);
  if (actualHash !== chunkHash) {
    logger.warn(
      { uploadSessionId, chunkIndex, expectedHash: chunkHash, actualHash },
      'Chunk hash mismatch'
    );
    throw new Error('Chunk hash mismatch');
  }

  // Check if chunk already exists in storage
  const exists = await chunkExists(chunkHash);

  if (!exists) {
    // Upload to MinIO
    const storageKey = await uploadChunk(chunkHash, data);

    // Add to chunks table
    await query(
      `INSERT INTO chunks (hash, size, storage_key, reference_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (hash) DO UPDATE SET reference_count = chunks.reference_count + 1`,
      [chunkHash, data.length, storageKey]
    );
  } else {
    // Increment reference count
    await query(`UPDATE chunks SET reference_count = reference_count + 1 WHERE hash = $1`, [
      chunkHash,
    ]);
  }

  // Update upload session
  await query(
    `UPDATE upload_sessions
     SET uploaded_chunks = uploaded_chunks + 1, status = 'uploading'
     WHERE id = $1`,
    [uploadSessionId]
  );

  logger.debug(
    {
      uploadSessionId,
      chunkIndex,
      chunkHash,
      chunkSize: data.length,
      deduplicated: exists,
      durationMs: Date.now() - startTime,
    },
    'Chunk uploaded'
  );

  return { uploaded: true };
}

/**
 * Completes an upload session and creates or updates the file record.
 * Handles versioning by saving current file state before updating.
 * Updates user storage quota and notifies connected clients.
 * @param userId - ID of uploading user
 * @param uploadSessionId - Upload session to complete
 * @param chunkHashes - Ordered list of all chunk hashes
 * @returns Created or updated file item
 * @throws Error if session not found or chunk count mismatch
 */
export async function completeUpload(
  userId: string,
  uploadSessionId: string,
  chunkHashes: string[]
): Promise<FileItem> {
  const startTime = Date.now();

  const session = await queryOne<{
    id: string;
    user_id: string;
    file_name: string;
    file_size: number;
    parent_id: string | null;
    total_chunks: number;
  }>(
    `SELECT id, user_id, file_name, file_size, parent_id, total_chunks
     FROM upload_sessions WHERE id = $1 AND user_id = $2`,
    [uploadSessionId, userId]
  );

  if (!session) {
    throw new Error('Upload session not found');
  }

  if (chunkHashes.length !== session.total_chunks) {
    throw new Error('Chunk count mismatch');
  }

  const contentHash = calculateContentHash(chunkHashes);
  const mimeType = getMimeType(session.file_name);

  const file = await transaction(async (client) => {
    // Check if file already exists (update vs create)
    const existing = await client.query(
      `SELECT id, version FROM files
       WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND name = $3 AND deleted_at IS NULL`,
      [userId, session.parent_id, session.file_name]
    );

    let fileId: string;
    let version: number;
    let isUpdate = false;

    if (existing.rows.length > 0) {
      // Update existing file - create new version
      fileId = existing.rows[0].id;
      version = existing.rows[0].version + 1;
      isUpdate = true;

      // Save current version to history
      const oldChunks = await client.query(
        `SELECT chunk_hash FROM file_chunks WHERE file_id = $1 ORDER BY chunk_index`,
        [fileId]
      );

      const versionResult = await client.query(
        `INSERT INTO file_versions (file_id, version, size, content_hash, created_by)
         VALUES ($1, $2, (SELECT size FROM files WHERE id = $1),
                 (SELECT content_hash FROM files WHERE id = $1), $3)
         RETURNING id`,
        [fileId, existing.rows[0].version, userId]
      );

      // Copy chunks to version
      for (let i = 0; i < oldChunks.rows.length; i++) {
        await client.query(
          `INSERT INTO file_version_chunks (version_id, chunk_index, chunk_hash, chunk_size)
           SELECT $1, chunk_index, chunk_hash, chunk_size FROM file_chunks
           WHERE file_id = $2 AND chunk_index = $3`,
          [versionResult.rows[0].id, fileId, i]
        );
      }

      // Delete old file chunks
      await client.query(`DELETE FROM file_chunks WHERE file_id = $1`, [fileId]);

      // Update file
      await client.query(
        `UPDATE files SET size = $1, content_hash = $2, version = $3,
                          mime_type = $4, updated_at = NOW(), sync_status = 'synced'
         WHERE id = $5`,
        [session.file_size, contentHash, version, mimeType, fileId]
      );
    } else {
      // Create new file
      version = 1;
      const result = await client.query(
        `INSERT INTO files (user_id, parent_id, name, is_folder, size, mime_type, content_hash, version, sync_status)
         VALUES ($1, $2, $3, false, $4, $5, $6, $7, 'synced')
         RETURNING id`,
        [
          userId,
          session.parent_id,
          session.file_name,
          session.file_size,
          mimeType,
          contentHash,
          version,
        ]
      );
      fileId = result.rows[0].id;
    }

    // Insert file chunks
    for (let i = 0; i < chunkHashes.length; i++) {
      const chunk = await client.query(`SELECT size FROM chunks WHERE hash = $1`, [chunkHashes[i]]);

      await client.query(
        `INSERT INTO file_chunks (file_id, chunk_index, chunk_hash, chunk_size)
         VALUES ($1, $2, $3, $4)`,
        [fileId, i, chunkHashes[i], chunk.rows[0]?.size || CHUNK_SIZE]
      );
    }

    // Update user storage usage
    await client.query(`UPDATE users SET used_bytes = used_bytes + $1 WHERE id = $2`, [
      session.file_size,
      userId,
    ]);

    // Mark upload session as completed
    await client.query(`UPDATE upload_sessions SET status = 'completed', file_id = $1 WHERE id = $2`, [
      fileId,
      uploadSessionId,
    ]);

    // Get the created/updated file
    const fileResult = await client.query(
      `SELECT id, user_id as "userId", parent_id as "parentId", name, is_folder as "isFolder",
              size, mime_type as "mimeType", content_hash as "contentHash", version,
              sync_status as "syncStatus", created_at as "createdAt", updated_at as "updatedAt"
       FROM files WHERE id = $1`,
      [fileId]
    );

    return { file: fileResult.rows[0] as FileItem, isUpdate };
  });

  // Update metrics
  uploadSessionsTotal.labels('completed').inc();
  uploadSessionsActive.dec();
  fileOperationsTotal.labels('upload', 'success').inc();
  storageUsedBytes.inc(session.file_size);

  // Notify other clients
  const eventType = file.isUpdate ? 'file_updated' : 'file_created';
  await publishSync(userId, { type: eventType, file: file.file });
  syncEventsTotal.labels(eventType).inc();
  await deleteCache(`folder:${userId}:${session.parent_id || 'root'}`);

  logFileOperation(
    {
      fileId: file.file.id,
      fileName: session.file_name,
      fileSize: session.file_size,
      userId,
      operation: 'upload',
    },
    `File ${file.isUpdate ? 'updated' : 'created'} successfully`
  );

  logger.info(
    {
      fileId: file.file.id,
      fileName: session.file_name,
      fileSize: session.file_size,
      version: file.file.version,
      isUpdate: file.isUpdate,
      durationMs: Date.now() - startTime,
    },
    'Upload completed'
  );

  return file.file;
}

/**
 * Creates a new folder in the file hierarchy.
 * @param userId - ID of owning user
 * @param name - Folder name
 * @param parentId - ID of parent folder (null for root)
 * @returns Created folder item
 * @throws Error if folder with same name already exists in parent
 */
export async function createFolder(
  userId: string,
  name: string,
  parentId: string | null
): Promise<FileItem> {
  // Check for duplicate name
  const existing = await queryOne(
    `SELECT id FROM files
     WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND name = $3 AND deleted_at IS NULL`,
    [userId, parentId, name]
  );

  if (existing) {
    throw new Error('A file or folder with this name already exists');
  }

  const result = await query<FileItem>(
    `INSERT INTO files (user_id, parent_id, name, is_folder, sync_status)
     VALUES ($1, $2, $3, true, 'synced')
     RETURNING id, user_id as "userId", parent_id as "parentId", name, is_folder as "isFolder",
               size, mime_type as "mimeType", content_hash as "contentHash", version,
               sync_status as "syncStatus", created_at as "createdAt", updated_at as "updatedAt"`,
    [userId, parentId, name]
  );

  // Update metrics
  folderOperationsTotal.labels('create', 'success').inc();

  await publishSync(userId, { type: 'folder_created', folder: result[0] });
  syncEventsTotal.labels('folder_created').inc();
  await deleteCache(`folder:${userId}:${parentId || 'root'}`);

  logFileOperation(
    {
      fileId: result[0].id,
      fileName: name,
      userId,
      operation: 'sync',
    },
    'Folder created'
  );

  return result[0];
}

/**
 * Retrieves the contents of a folder for the file browser.
 * Returns items sorted with folders first, then files alphabetically.
 * Builds breadcrumb trail for navigation.
 * @param userId - ID of user viewing folder
 * @param folderId - Folder to list contents of (null for root)
 * @returns Folder metadata, child items, and breadcrumb trail
 * @throws Error if folder not found
 */
export async function getFolderContents(
  userId: string,
  folderId: string | null
): Promise<{ folder: FileItem | null; items: FileItem[]; breadcrumbs: Array<{ id: string; name: string }> }> {
  let folder: FileItem | null = null;

  if (folderId) {
    folder = await queryOne<FileItem>(
      `SELECT id, user_id as "userId", parent_id as "parentId", name, is_folder as "isFolder",
              size, mime_type as "mimeType", content_hash as "contentHash", version,
              sync_status as "syncStatus", created_at as "createdAt", updated_at as "updatedAt"
       FROM files WHERE id = $1 AND user_id = $2 AND is_folder = true AND deleted_at IS NULL`,
      [folderId, userId]
    );

    if (!folder) {
      throw new Error('Folder not found');
    }
  }

  const items = await query<FileItem>(
    `SELECT id, user_id as "userId", parent_id as "parentId", name, is_folder as "isFolder",
            size, mime_type as "mimeType", content_hash as "contentHash", version,
            sync_status as "syncStatus", created_at as "createdAt", updated_at as "updatedAt"
     FROM files
     WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL
     ORDER BY is_folder DESC, name ASC`,
    [userId, folderId]
  );

  // Build breadcrumbs
  const breadcrumbs: Array<{ id: string; name: string }> = [];
  let currentId = folderId;

  while (currentId) {
    const parent = await queryOne<{ id: string; name: string; parent_id: string | null }>(
      `SELECT id, name, parent_id FROM files WHERE id = $1`,
      [currentId]
    );

    if (parent) {
      breadcrumbs.unshift({ id: parent.id, name: parent.name });
      currentId = parent.parent_id;
    } else {
      break;
    }
  }

  return { folder, items, breadcrumbs };
}

/**
 * Retrieves a single file or folder by ID.
 * Only returns items owned by the specified user.
 * @param userId - ID of owning user
 * @param fileId - ID of file/folder to retrieve
 * @returns File/folder item or null if not found
 */
export async function getFile(userId: string, fileId: string): Promise<FileItem | null> {
  return queryOne<FileItem>(
    `SELECT id, user_id as "userId", parent_id as "parentId", name, is_folder as "isFolder",
            size, mime_type as "mimeType", content_hash as "contentHash", version,
            sync_status as "syncStatus", created_at as "createdAt", updated_at as "updatedAt"
     FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [fileId, userId]
  );
}

/**
 * Retrieves the ordered list of chunks that make up a file.
 * @param fileId - ID of file to get chunks for
 * @returns Array of chunk references in order
 */
export async function getFileChunks(fileId: string): Promise<FileChunk[]> {
  return query<FileChunk>(
    `SELECT id, file_id as "fileId", chunk_index as "chunkIndex",
            chunk_hash as "chunkHash", chunk_size as "chunkSize", created_at as "createdAt"
     FROM file_chunks WHERE file_id = $1 ORDER BY chunk_index`,
    [fileId]
  );
}

/**
 * Downloads a complete file by reassembling its chunks.
 * Retrieves each chunk from object storage and concatenates them.
 * @param userId - ID of user downloading
 * @param fileId - ID of file to download
 * @returns File data buffer and file metadata
 * @throws Error if file not found or is a folder
 */
export async function downloadFile(
  userId: string,
  fileId: string
): Promise<{ data: Buffer; file: FileItem }> {
  const startTime = Date.now();
  const file = await getFile(userId, fileId);

  if (!file || file.isFolder) {
    throw new Error('File not found');
  }

  const chunks = await getFileChunks(fileId);
  const chunkBuffers: Buffer[] = [];

  for (const chunk of chunks) {
    const data = await downloadChunk(chunk.chunkHash);
    chunkBuffers.push(data);
  }

  const data = Buffer.concat(chunkBuffers);

  // Update metrics
  fileDownloadsTotal.labels('direct').inc();
  fileOperationsTotal.labels('download', 'success').inc();

  logFileOperation(
    {
      fileId,
      fileName: file.name,
      fileSize: file.size,
      userId,
      operation: 'download',
    },
    'File downloaded'
  );

  logger.info(
    {
      fileId,
      fileName: file.name,
      fileSize: data.length,
      chunks: chunks.length,
      durationMs: Date.now() - startTime,
    },
    'File download completed'
  );

  return { data, file };
}

/**
 * Renames a file or folder.
 * @param userId - ID of owning user
 * @param itemId - ID of item to rename
 * @param newName - New name for the item
 * @returns Updated item
 * @throws Error if item not found or name already exists in parent
 */
export async function renameItem(userId: string, itemId: string, newName: string): Promise<FileItem> {
  const item = await getFile(userId, itemId);

  if (!item) {
    throw new Error('Item not found');
  }

  // Check for duplicate name
  const existing = await queryOne(
    `SELECT id FROM files
     WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND name = $3 AND id != $4 AND deleted_at IS NULL`,
    [userId, item.parentId, newName, itemId]
  );

  if (existing) {
    throw new Error('A file or folder with this name already exists');
  }

  const result = await query<FileItem>(
    `UPDATE files SET name = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3
     RETURNING id, user_id as "userId", parent_id as "parentId", name, is_folder as "isFolder",
               size, mime_type as "mimeType", content_hash as "contentHash", version,
               sync_status as "syncStatus", created_at as "createdAt", updated_at as "updatedAt"`,
    [newName, itemId, userId]
  );

  // Update metrics
  const operationType = item.isFolder ? folderOperationsTotal : fileOperationsTotal;
  operationType.labels('rename', 'success').inc();

  await publishSync(userId, { type: 'item_renamed', item: result[0] });
  syncEventsTotal.labels('item_renamed').inc();
  await deleteCache(`folder:${userId}:${item.parentId || 'root'}`);

  logFileOperation(
    {
      fileId: itemId,
      fileName: newName,
      userId,
      operation: 'rename',
    },
    `${item.isFolder ? 'Folder' : 'File'} renamed`
  );

  return result[0];
}

/**
 * Moves a file or folder to a different parent folder.
 * Validates that the move is allowed (prevents moving folder into itself).
 * @param userId - ID of owning user
 * @param itemId - ID of item to move
 * @param newParentId - ID of destination folder (null for root)
 * @returns Updated item
 * @throws Error if item or destination not found, or invalid move
 */
export async function moveItem(
  userId: string,
  itemId: string,
  newParentId: string | null
): Promise<FileItem> {
  const item = await getFile(userId, itemId);

  if (!item) {
    throw new Error('Item not found');
  }

  // Verify new parent exists and is a folder
  if (newParentId) {
    const newParent = await getFile(userId, newParentId);
    if (!newParent || !newParent.isFolder) {
      throw new Error('Destination folder not found');
    }

    // Prevent moving folder into itself or its children
    if (item.isFolder) {
      let currentId: string | null = newParentId;
      while (currentId) {
        if (currentId === itemId) {
          throw new Error('Cannot move folder into itself or its children');
        }
        const parent = await queryOne<{ parent_id: string | null }>(
          `SELECT parent_id FROM files WHERE id = $1`,
          [currentId]
        );
        currentId = parent?.parent_id || null;
      }
    }
  }

  // Check for duplicate name in destination
  const existing = await queryOne(
    `SELECT id FROM files
     WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND name = $3 AND id != $4 AND deleted_at IS NULL`,
    [userId, newParentId, item.name, itemId]
  );

  if (existing) {
    throw new Error('A file or folder with this name already exists in the destination');
  }

  const oldParentId = item.parentId;

  const result = await query<FileItem>(
    `UPDATE files SET parent_id = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3
     RETURNING id, user_id as "userId", parent_id as "parentId", name, is_folder as "isFolder",
               size, mime_type as "mimeType", content_hash as "contentHash", version,
               sync_status as "syncStatus", created_at as "createdAt", updated_at as "updatedAt"`,
    [newParentId, itemId, userId]
  );

  // Update metrics
  const operationType = item.isFolder ? folderOperationsTotal : fileOperationsTotal;
  operationType.labels('move', 'success').inc();

  await publishSync(userId, { type: 'item_moved', item: result[0] });
  syncEventsTotal.labels('item_moved').inc();
  await deleteCache(`folder:${userId}:${oldParentId || 'root'}`);
  await deleteCache(`folder:${userId}:${newParentId || 'root'}`);

  logFileOperation(
    {
      fileId: itemId,
      fileName: item.name,
      userId,
      operation: 'move',
    },
    `${item.isFolder ? 'Folder' : 'File'} moved`
  );

  return result[0];
}

/**
 * Soft-deletes a file or folder and all its children.
 * Items are marked with deleted_at timestamp rather than removed.
 * Updates user's storage usage for deleted files.
 * @param userId - ID of owning user
 * @param itemId - ID of item to delete
 * @throws Error if item not found
 */
export async function deleteItem(userId: string, itemId: string): Promise<void> {
  const item = await getFile(userId, itemId);

  if (!item) {
    throw new Error('Item not found');
  }

  await transaction(async (client) => {
    // Soft delete the item and all children
    await client.query(
      `WITH RECURSIVE children AS (
         SELECT id FROM files WHERE id = $1
         UNION ALL
         SELECT f.id FROM files f JOIN children c ON f.parent_id = c.id
       )
       UPDATE files SET deleted_at = NOW() WHERE id IN (SELECT id FROM children)`,
      [itemId]
    );

    // Update user storage (for files, not folders)
    if (!item.isFolder) {
      await client.query(`UPDATE users SET used_bytes = used_bytes - $1 WHERE id = $2`, [
        item.size,
        userId,
      ]);
      storageUsedBytes.dec(item.size);
    }
  });

  // Update metrics
  const operationType = item.isFolder ? folderOperationsTotal : fileOperationsTotal;
  operationType.labels('delete', 'success').inc();

  await publishSync(userId, { type: 'item_deleted', itemId });
  syncEventsTotal.labels('item_deleted').inc();
  await deleteCache(`folder:${userId}:${item.parentId || 'root'}`);

  logFileOperation(
    {
      fileId: itemId,
      fileName: item.name,
      userId,
      operation: 'delete',
    },
    `${item.isFolder ? 'Folder' : 'File'} deleted`
  );
}

/**
 * Retrieves version history for a file.
 * @param userId - ID of owning user
 * @param fileId - ID of file to get versions for
 * @returns Array of previous versions, ordered newest first
 * @throws Error if file not found
 */
export async function getFileVersions(userId: string, fileId: string): Promise<FileVersion[]> {
  const file = await getFile(userId, fileId);

  if (!file) {
    throw new Error('File not found');
  }

  return query<FileVersion>(
    `SELECT id, file_id as "fileId", version, size, content_hash as "contentHash",
            created_at as "createdAt", created_by as "createdBy"
     FROM file_versions WHERE file_id = $1 ORDER BY version DESC`,
    [fileId]
  );
}

/**
 * Restores a file to a previous version.
 * Saves the current version to history before restoring.
 * Updates user's storage usage based on size difference.
 * @param userId - ID of owning user
 * @param fileId - ID of file to restore
 * @param versionId - ID of version to restore to
 * @returns Updated file with restored content
 * @throws Error if file or version not found
 */
export async function restoreFileVersion(
  userId: string,
  fileId: string,
  versionId: string
): Promise<FileItem> {
  const file = await getFile(userId, fileId);

  if (!file) {
    throw new Error('File not found');
  }

  const version = await queryOne<FileVersion>(
    `SELECT * FROM file_versions WHERE id = $1 AND file_id = $2`,
    [versionId, fileId]
  );

  if (!version) {
    throw new Error('Version not found');
  }

  const restoredFile = await transaction(async (client) => {
    // Get version chunks
    const versionChunks = await client.query(
      `SELECT chunk_index, chunk_hash, chunk_size FROM file_version_chunks
       WHERE version_id = $1 ORDER BY chunk_index`,
      [versionId]
    );

    // Save current version
    const currentVersion = file.version + 1;

    const newVersionResult = await client.query(
      `INSERT INTO file_versions (file_id, version, size, content_hash, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [fileId, file.version, file.size, file.contentHash, userId]
    );

    // Copy current chunks to version
    await client.query(
      `INSERT INTO file_version_chunks (version_id, chunk_index, chunk_hash, chunk_size)
       SELECT $1, chunk_index, chunk_hash, chunk_size FROM file_chunks WHERE file_id = $2`,
      [newVersionResult.rows[0].id, fileId]
    );

    // Clear current chunks
    await client.query(`DELETE FROM file_chunks WHERE file_id = $1`, [fileId]);

    // Restore version chunks
    for (const chunk of versionChunks.rows) {
      await client.query(
        `INSERT INTO file_chunks (file_id, chunk_index, chunk_hash, chunk_size)
         VALUES ($1, $2, $3, $4)`,
        [fileId, chunk.chunk_index, chunk.chunk_hash, chunk.chunk_size]
      );
    }

    // Update file
    const chunkHashes = versionChunks.rows.map((c: { chunk_hash: string }) => c.chunk_hash);
    const contentHash = calculateContentHash(chunkHashes);

    await client.query(
      `UPDATE files SET size = $1, content_hash = $2, version = $3, updated_at = NOW()
       WHERE id = $4`,
      [version.size, contentHash, currentVersion, fileId]
    );

    // Update user storage
    const sizeDiff = version.size - file.size;
    await client.query(`UPDATE users SET used_bytes = used_bytes + $1 WHERE id = $2`, [
      sizeDiff,
      userId,
    ]);

    if (sizeDiff > 0) {
      storageUsedBytes.inc(sizeDiff);
    } else {
      storageUsedBytes.dec(Math.abs(sizeDiff));
    }

    // Get updated file
    const result = await client.query(
      `SELECT id, user_id as "userId", parent_id as "parentId", name, is_folder as "isFolder",
              size, mime_type as "mimeType", content_hash as "contentHash", version,
              sync_status as "syncStatus", created_at as "createdAt", updated_at as "updatedAt"
       FROM files WHERE id = $1`,
      [fileId]
    );

    return result.rows[0] as FileItem;
  });

  // Update metrics
  fileOperationsTotal.labels('restore', 'success').inc();

  logFileOperation(
    {
      fileId,
      fileName: file.name,
      userId,
      operation: 'version',
    },
    `File restored to version ${version.version}`
  );

  return restoredFile;
}
