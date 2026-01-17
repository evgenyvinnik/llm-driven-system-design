/**
 * Type definitions for the Dropbox-clone frontend.
 * These types mirror the backend API response structures.
 * @module types
 */

/** Represents an authenticated user in the system */
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  /** Storage quota in bytes */
  quotaBytes: number;
  /** Current storage usage in bytes */
  usedBytes: number;
}

/** Represents a file or folder in the storage hierarchy */
export interface FileItem {
  id: string;
  userId: string;
  /** ID of parent folder, null for root level items */
  parentId: string | null;
  name: string;
  isFolder: boolean;
  /** Size in bytes (0 for folders) */
  size: number;
  mimeType: string | null;
  /** SHA-256 hash of file content for deduplication */
  contentHash: string | null;
  version: number;
  syncStatus: 'synced' | 'syncing' | 'pending' | 'error';
  createdAt: string;
  updatedAt: string;
}

/** Represents a historical version of a file */
export interface FileVersion {
  id: string;
  fileId: string;
  version: number;
  size: number;
  contentHash: string | null;
  createdAt: string;
  createdBy: string | null;
}

/** Represents a public shareable link to a file */
export interface SharedLink {
  id: string;
  fileId: string;
  urlToken: string;
  expiresAt: string | null;
  downloadCount: number;
  maxDownloads: number | null;
  accessLevel: 'view' | 'download' | 'edit';
  createdAt: string;
  url?: string;
  fileName?: string;
}

/** Represents a folder shared directly with a specific user */
export interface FolderShare {
  id: string;
  folderId: string;
  sharedWith: string;
  accessLevel: 'view' | 'edit';
  createdAt: string;
  email?: string;
  name?: string;
}

/** Response from folder listing with navigation breadcrumbs */
export interface FolderContents {
  folder: FileItem | null;
  items: FileItem[];
  breadcrumbs: Array<{ id: string; name: string }>;
}

/** Response from upload session initialization */
export interface UploadSession {
  uploadSessionId: string;
  chunksNeeded: string[];
  totalChunks: number;
}

/** System-wide statistics for admin dashboard */
export interface SystemStats {
  totalUsers: number;
  totalFiles: number;
  totalStorage: number;
  totalChunks: number;
  actualStorageUsed: number;
  logicalStorageUsed: number;
  deduplicationRatio: number;
  storageSaved: number;
}
