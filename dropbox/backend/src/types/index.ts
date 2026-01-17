/**
 * Type definitions for the Dropbox-clone cloud storage API.
 * These types define the core data structures used throughout the backend
 * for file management, user accounts, sharing, and synchronization.
 * @module types
 */

/**
 * Represents a user account in the system.
 * Users have storage quotas and can own files, folders, and shared links.
 */
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  quotaBytes: number;
  usedBytes: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Represents a file or folder in the storage hierarchy.
 * Files are stored as references to content-addressed chunks for deduplication.
 * Folders are containers that can hold other files and folders.
 */
export interface FileItem {
  id: string;
  userId: string;
  parentId: string | null;
  name: string;
  isFolder: boolean;
  size: number;
  mimeType: string | null;
  contentHash: string | null;
  version: number;
  syncStatus: 'synced' | 'syncing' | 'pending' | 'error';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Represents the association between a file and its constituent chunks.
 * This enables reconstructing a file from its ordered sequence of chunks.
 */
export interface FileChunk {
  id: string;
  fileId: string;
  chunkIndex: number;
  chunkHash: string;
  chunkSize: number;
  createdAt: Date;
}

/**
 * Represents a content-addressed storage chunk.
 * Chunks are deduplicated by hash - identical content shares the same chunk.
 * Reference counting tracks how many files use each chunk for garbage collection.
 */
export interface Chunk {
  hash: string;
  size: number;
  storageKey: string;
  referenceCount: number;
  createdAt: Date;
}

/**
 * Represents a historical version of a file.
 * Version history enables users to restore previous file states.
 * Versions share chunks with current files for storage efficiency.
 */
export interface FileVersion {
  id: string;
  fileId: string;
  version: number;
  size: number;
  contentHash: string | null;
  createdAt: Date;
  createdBy: string | null;
}

/**
 * Represents a shareable link to a file.
 * Links can be password-protected, time-limited, and download-limited.
 * Provides public access to files without requiring account authentication.
 */
export interface SharedLink {
  id: string;
  fileId: string;
  createdBy: string;
  urlToken: string;
  passwordHash: string | null;
  expiresAt: Date | null;
  downloadCount: number;
  maxDownloads: number | null;
  accessLevel: 'view' | 'download' | 'edit';
  createdAt: Date;
}

/**
 * Represents sharing a folder with a specific user.
 * Unlike shared links, folder shares are user-specific and persist
 * until explicitly revoked. Shared folders appear in recipients' "Shared with me" view.
 */
export interface FolderShare {
  id: string;
  folderId: string;
  sharedWith: string;
  accessLevel: 'view' | 'edit' | 'owner';
  createdAt: Date;
}

/**
 * Represents an in-progress file upload.
 * Upload sessions enable resumable uploads and chunk-by-chunk progress tracking.
 * Sessions expire if not completed within a time limit.
 */
export interface UploadSession {
  id: string;
  userId: string;
  fileId: string | null;
  fileName: string;
  fileSize: number;
  parentId: string | null;
  totalChunks: number;
  uploadedChunks: number;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Represents an authenticated user session.
 * Sessions are stored in Redis for fast lookup and in PostgreSQL for persistence.
 */
export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

// API Request/Response types

/**
 * Request body for initializing a file upload session.
 * Includes chunk hashes upfront to enable deduplication - the server responds
 * with which chunks actually need to be uploaded.
 */
export interface CreateUploadSessionRequest {
  fileName: string;
  fileSize: number;
  parentId?: string;
  chunkHashes: string[];
}

/**
 * Response from upload session initialization.
 * The chunksNeeded array identifies which chunks must be uploaded
 * (chunks already in storage from other files are skipped).
 */
export interface CreateUploadSessionResponse {
  uploadSessionId: string;
  chunksNeeded: string[];
  totalChunks: number;
}

/**
 * Request body for uploading a single file chunk.
 * The chunk hash is verified server-side to ensure data integrity.
 */
export interface UploadChunkRequest {
  uploadSessionId: string;
  chunkIndex: number;
  chunkHash: string;
}

/**
 * Request body for finalizing an upload session and creating the file record.
 */
export interface CompleteUploadRequest {
  uploadSessionId: string;
}

/**
 * Request body for creating a new folder.
 */
export interface CreateFolderRequest {
  name: string;
  parentId?: string;
}

/**
 * Request body for renaming a file or folder.
 */
export interface RenameItemRequest {
  name: string;
}

/**
 * Request body for moving a file or folder to a different parent folder.
 */
export interface MoveItemRequest {
  parentId: string | null;
}

/**
 * Request body for creating a shareable link to a file.
 */
export interface CreateShareLinkRequest {
  fileId: string;
  accessLevel?: 'view' | 'download' | 'edit';
  password?: string;
  expiresIn?: number; // hours
  maxDownloads?: number;
}

/**
 * Request body for sharing a folder with another user.
 */
export interface ShareFolderRequest {
  email: string;
  accessLevel: 'view' | 'edit';
}

// Auth types

/**
 * Request body for user login.
 */
export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * Request body for new user registration.
 */
export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

/**
 * Response from successful login or registration.
 * Contains the user profile and session token.
 */
export interface AuthResponse {
  user: Omit<User, 'createdAt' | 'updatedAt'>;
  token: string;
}

// File browser types

/**
 * Response containing the contents of a folder for the file browser.
 * Includes breadcrumbs for navigation and the list of child items.
 */
export interface FolderContents {
  folder: FileItem | null;
  items: FileItem[];
  breadcrumbs: Array<{ id: string; name: string }>;
}

// Admin types

/**
 * System-wide statistics for the admin dashboard.
 * Includes user counts, storage metrics, and deduplication efficiency.
 */
export interface SystemStats {
  totalUsers: number;
  totalFiles: number;
  totalStorage: number;
  totalChunks: number;
  deduplicationRatio: number;
}
