/**
 * File and folder metadata operations.
 *
 * Features:
 * - CRUD operations for files and folders
 * - Folder navigation and breadcrumbs
 * - File/folder renaming and moving
 * - Soft delete with recursive child deletion
 *
 * @module services/file/metadata
 */

import {
  query,
  queryOne,
  transaction,
  FileItem,
  publishSync,
  deleteCache,
  logFileOperation,
  fileOperationsTotal,
  folderOperationsTotal,
  syncEventsTotal,
  storageUsedBytes,
} from './types.js';

/**
 * Retrieves a single file or folder by ID.
 * Only returns items owned by the specified user.
 *
 * @description Fetches metadata for a single file or folder, ensuring
 * the user has ownership. Excludes soft-deleted items.
 *
 * @param {string} userId - The ID of the user requesting the file
 * @param {string} fileId - The ID of the file or folder to retrieve
 * @returns {Promise<FileItem | null>} The file/folder metadata, or null if not found
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
 * Creates a new folder in the file hierarchy.
 *
 * @description Creates a folder with the specified name under the given parent.
 * Validates that no duplicate name exists in the same location. Publishes
 * a sync event and invalidates relevant caches.
 *
 * @param {string} userId - The ID of the user creating the folder
 * @param {string} name - The name of the new folder
 * @param {string | null} parentId - The ID of the parent folder, or null for root
 * @returns {Promise<FileItem>} The newly created folder metadata
 * @throws {Error} If a file or folder with the same name already exists
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
 *
 * @description Fetches all items within a folder along with navigation
 * breadcrumbs. Items are sorted with folders appearing before files,
 * and each group sorted alphabetically by name.
 *
 * @param {string} userId - The ID of the user requesting folder contents
 * @param {string | null} folderId - The ID of the folder to list, or null for root
 * @returns {Promise<{ folder: FileItem | null; items: FileItem[]; breadcrumbs: Array<{ id: string; name: string }> }>}
 *   Object containing the current folder metadata (null for root), list of items,
 *   and breadcrumb navigation trail from root to current folder
 * @throws {Error} If specified folder is not found
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
 * Renames a file or folder.
 *
 * @description Updates the name of an existing file or folder. Validates
 * that no duplicate name exists in the same parent folder. Publishes
 * a sync event and invalidates relevant caches.
 *
 * @param {string} userId - The ID of the user performing the rename
 * @param {string} itemId - The ID of the file or folder to rename
 * @param {string} newName - The new name for the item
 * @returns {Promise<FileItem>} The renamed item metadata
 * @throws {Error} If item is not found
 * @throws {Error} If a file or folder with the new name already exists
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
 *
 * @description Relocates an item to a new parent folder. Performs validation
 * to prevent circular references (moving a folder into its own subtree) and
 * checks for duplicate names in the destination. Updates sync events and caches.
 *
 * @param {string} userId - The ID of the user performing the move
 * @param {string} itemId - The ID of the file or folder to move
 * @param {string | null} newParentId - The ID of the destination folder, or null for root
 * @returns {Promise<FileItem>} The moved item metadata with updated parentId
 * @throws {Error} If item is not found
 * @throws {Error} If destination folder is not found
 * @throws {Error} If attempting to move a folder into itself or its children
 * @throws {Error} If a file or folder with the same name exists in destination
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
        const parentRow: { parent_id: string | null } | null = await queryOne<{ parent_id: string | null }>(
          `SELECT parent_id FROM files WHERE id = $1`,
          [currentId]
        );
        currentId = parentRow !== null ? parentRow.parent_id : null;
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
 *
 * @description Performs a soft delete by setting the deleted_at timestamp
 * on the item and all its descendants (for folders). Storage quota is
 * adjusted for deleted files. Items can potentially be restored later.
 *
 * @param {string} userId - The ID of the user performing the deletion
 * @param {string} itemId - The ID of the file or folder to delete
 * @returns {Promise<void>} Resolves when deletion is complete
 * @throws {Error} If item is not found
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
