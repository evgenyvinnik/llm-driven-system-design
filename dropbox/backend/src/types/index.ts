// Type definitions for Dropbox API

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

export interface FileChunk {
  id: string;
  fileId: string;
  chunkIndex: number;
  chunkHash: string;
  chunkSize: number;
  createdAt: Date;
}

export interface Chunk {
  hash: string;
  size: number;
  storageKey: string;
  referenceCount: number;
  createdAt: Date;
}

export interface FileVersion {
  id: string;
  fileId: string;
  version: number;
  size: number;
  contentHash: string | null;
  createdAt: Date;
  createdBy: string | null;
}

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

export interface FolderShare {
  id: string;
  folderId: string;
  sharedWith: string;
  accessLevel: 'view' | 'edit' | 'owner';
  createdAt: Date;
}

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

export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

// API Request/Response types
export interface CreateUploadSessionRequest {
  fileName: string;
  fileSize: number;
  parentId?: string;
  chunkHashes: string[];
}

export interface CreateUploadSessionResponse {
  uploadSessionId: string;
  chunksNeeded: string[];
  totalChunks: number;
}

export interface UploadChunkRequest {
  uploadSessionId: string;
  chunkIndex: number;
  chunkHash: string;
}

export interface CompleteUploadRequest {
  uploadSessionId: string;
}

export interface CreateFolderRequest {
  name: string;
  parentId?: string;
}

export interface RenameItemRequest {
  name: string;
}

export interface MoveItemRequest {
  parentId: string | null;
}

export interface CreateShareLinkRequest {
  fileId: string;
  accessLevel?: 'view' | 'download' | 'edit';
  password?: string;
  expiresIn?: number; // hours
  maxDownloads?: number;
}

export interface ShareFolderRequest {
  email: string;
  accessLevel: 'view' | 'edit';
}

// Auth types
export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface AuthResponse {
  user: Omit<User, 'createdAt' | 'updatedAt'>;
  token: string;
}

// File browser types
export interface FolderContents {
  folder: FileItem | null;
  items: FileItem[];
  breadcrumbs: Array<{ id: string; name: string }>;
}

// Admin types
export interface SystemStats {
  totalUsers: number;
  totalFiles: number;
  totalStorage: number;
  totalChunks: number;
  deduplicationRatio: number;
}
