import { query, queryOne } from '../utils/database.js';
import { SharedLink, FolderShare, FileItem, User } from '../types/index.js';
import { generateToken } from '../utils/chunking.js';
import bcrypt from 'bcrypt';

// Create shared link
export async function createSharedLink(
  userId: string,
  fileId: string,
  options: {
    accessLevel?: 'view' | 'download' | 'edit';
    password?: string;
    expiresInHours?: number;
    maxDownloads?: number;
  } = {}
): Promise<SharedLink> {
  // Verify file exists and user owns it
  const file = await queryOne<FileItem>(
    `SELECT id, user_id as "userId" FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [fileId]
  );

  if (!file || file.userId !== userId) {
    throw new Error('File not found');
  }

  const urlToken = generateToken(32);
  const accessLevel = options.accessLevel || 'view';
  const passwordHash = options.password ? await bcrypt.hash(options.password, 10) : null;
  const expiresAt = options.expiresInHours
    ? new Date(Date.now() + options.expiresInHours * 60 * 60 * 1000)
    : null;

  const result = await query<SharedLink>(
    `INSERT INTO shared_links (file_id, created_by, url_token, password_hash, expires_at, max_downloads, access_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, file_id as "fileId", created_by as "createdBy", url_token as "urlToken",
               expires_at as "expiresAt", download_count as "downloadCount",
               max_downloads as "maxDownloads", access_level as "accessLevel", created_at as "createdAt"`,
    [fileId, userId, urlToken, passwordHash, expiresAt, options.maxDownloads, accessLevel]
  );

  return result[0];
}

// Get shared link by token
export async function getSharedLinkByToken(urlToken: string): Promise<SharedLink | null> {
  return queryOne<SharedLink>(
    `SELECT id, file_id as "fileId", created_by as "createdBy", url_token as "urlToken",
            password_hash as "passwordHash", expires_at as "expiresAt",
            download_count as "downloadCount", max_downloads as "maxDownloads",
            access_level as "accessLevel", created_at as "createdAt"
     FROM shared_links WHERE url_token = $1`,
    [urlToken]
  );
}

// Validate shared link access
export async function validateSharedLink(
  urlToken: string,
  password?: string
): Promise<{ valid: boolean; file?: FileItem; error?: string }> {
  const link = await getSharedLinkByToken(urlToken);

  if (!link) {
    return { valid: false, error: 'Link not found' };
  }

  // Check expiration
  if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
    return { valid: false, error: 'Link has expired' };
  }

  // Check download limit
  if (link.maxDownloads && link.downloadCount >= link.maxDownloads) {
    return { valid: false, error: 'Download limit reached' };
  }

  // Check password
  if (link.passwordHash) {
    if (!password) {
      return { valid: false, error: 'Password required' };
    }
    const passwordMatch = await bcrypt.compare(password, link.passwordHash);
    if (!passwordMatch) {
      return { valid: false, error: 'Invalid password' };
    }
  }

  // Get file
  const file = await queryOne<FileItem>(
    `SELECT id, user_id as "userId", parent_id as "parentId", name, is_folder as "isFolder",
            size, mime_type as "mimeType", content_hash as "contentHash", version,
            sync_status as "syncStatus", created_at as "createdAt", updated_at as "updatedAt"
     FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [link.fileId]
  );

  if (!file) {
    return { valid: false, error: 'File no longer exists' };
  }

  return { valid: true, file };
}

// Increment download count
export async function incrementDownloadCount(urlToken: string): Promise<void> {
  await query(
    `UPDATE shared_links SET download_count = download_count + 1 WHERE url_token = $1`,
    [urlToken]
  );
}

// Get user's shared links
export async function getUserSharedLinks(userId: string): Promise<SharedLink[]> {
  return query<SharedLink>(
    `SELECT sl.id, sl.file_id as "fileId", sl.created_by as "createdBy",
            sl.url_token as "urlToken", sl.expires_at as "expiresAt",
            sl.download_count as "downloadCount", sl.max_downloads as "maxDownloads",
            sl.access_level as "accessLevel", sl.created_at as "createdAt",
            f.name as "fileName"
     FROM shared_links sl
     JOIN files f ON sl.file_id = f.id
     WHERE sl.created_by = $1
     ORDER BY sl.created_at DESC`,
    [userId]
  );
}

// Delete shared link
export async function deleteSharedLink(userId: string, linkId: string): Promise<void> {
  const result = await query(
    `DELETE FROM shared_links WHERE id = $1 AND created_by = $2`,
    [linkId, userId]
  );

  if (!result) {
    throw new Error('Link not found');
  }
}

// Share folder with user
export async function shareFolderWithUser(
  ownerId: string,
  folderId: string,
  email: string,
  accessLevel: 'view' | 'edit'
): Promise<FolderShare> {
  // Verify folder exists and user owns it
  const folder = await queryOne<FileItem>(
    `SELECT id, user_id as "userId", is_folder as "isFolder"
     FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [folderId]
  );

  if (!folder || folder.userId !== ownerId) {
    throw new Error('Folder not found');
  }

  if (!folder.isFolder) {
    throw new Error('Only folders can be shared with specific users');
  }

  // Find user to share with
  const sharedWithUser = await queryOne<User>(
    `SELECT id FROM users WHERE email = $1`,
    [email]
  );

  if (!sharedWithUser) {
    throw new Error('User not found');
  }

  if (sharedWithUser.id === ownerId) {
    throw new Error('Cannot share folder with yourself');
  }

  // Create or update share
  const result = await query<FolderShare>(
    `INSERT INTO folder_shares (folder_id, shared_with, access_level)
     VALUES ($1, $2, $3)
     ON CONFLICT (folder_id, shared_with)
     DO UPDATE SET access_level = $3
     RETURNING id, folder_id as "folderId", shared_with as "sharedWith",
               access_level as "accessLevel", created_at as "createdAt"`,
    [folderId, sharedWithUser.id, accessLevel]
  );

  return result[0];
}

// Get folders shared with user
export async function getSharedWithMe(userId: string): Promise<FileItem[]> {
  return query<FileItem>(
    `SELECT f.id, f.user_id as "userId", f.parent_id as "parentId", f.name, f.is_folder as "isFolder",
            f.size, f.mime_type as "mimeType", f.content_hash as "contentHash", f.version,
            f.sync_status as "syncStatus", f.created_at as "createdAt", f.updated_at as "updatedAt",
            fs.access_level as "shareAccessLevel",
            u.name as "ownerName"
     FROM folder_shares fs
     JOIN files f ON fs.folder_id = f.id
     JOIN users u ON f.user_id = u.id
     WHERE fs.shared_with = $1 AND f.deleted_at IS NULL`,
    [userId]
  );
}

// Check if user has access to file/folder
export async function checkAccess(
  userId: string,
  fileId: string,
  requiredLevel: 'view' | 'edit'
): Promise<boolean> {
  // Check if owner
  const file = await queryOne<FileItem>(
    `SELECT id, user_id as "userId", parent_id as "parentId"
     FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [fileId]
  );

  if (!file) {
    return false;
  }

  if (file.userId === userId) {
    return true;
  }

  // Check folder shares up the hierarchy
  let currentId: string | null = file.isFolder ? fileId : file.parentId;

  while (currentId) {
    const share = await queryOne<FolderShare>(
      `SELECT access_level as "accessLevel"
       FROM folder_shares WHERE folder_id = $1 AND shared_with = $2`,
      [currentId, userId]
    );

    if (share) {
      if (requiredLevel === 'view') {
        return true;
      }
      if (requiredLevel === 'edit' && share.accessLevel === 'edit') {
        return true;
      }
    }

    const parent = await queryOne<{ parent_id: string | null }>(
      `SELECT parent_id FROM files WHERE id = $1`,
      [currentId]
    );

    currentId = parent?.parent_id || null;
  }

  return false;
}

// Remove folder share
export async function removeFolderShare(
  ownerId: string,
  folderId: string,
  sharedWithId: string
): Promise<void> {
  // Verify ownership
  const folder = await queryOne<FileItem>(
    `SELECT user_id as "userId" FROM files WHERE id = $1`,
    [folderId]
  );

  if (!folder || folder.userId !== ownerId) {
    throw new Error('Folder not found');
  }

  await query(
    `DELETE FROM folder_shares WHERE folder_id = $1 AND shared_with = $2`,
    [folderId, sharedWithId]
  );
}

// Get folder shares for a folder
export async function getFolderShares(userId: string, folderId: string): Promise<Array<FolderShare & { email: string; name: string }>> {
  // Verify ownership
  const folder = await queryOne<FileItem>(
    `SELECT user_id as "userId" FROM files WHERE id = $1`,
    [folderId]
  );

  if (!folder || folder.userId !== userId) {
    throw new Error('Folder not found');
  }

  return query(
    `SELECT fs.id, fs.folder_id as "folderId", fs.shared_with as "sharedWith",
            fs.access_level as "accessLevel", fs.created_at as "createdAt",
            u.email, u.name
     FROM folder_shares fs
     JOIN users u ON fs.shared_with = u.id
     WHERE fs.folder_id = $1`,
    [folderId]
  );
}
