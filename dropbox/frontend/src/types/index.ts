export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  quotaBytes: number;
  usedBytes: number;
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
  createdAt: string;
  updatedAt: string;
}

export interface FileVersion {
  id: string;
  fileId: string;
  version: number;
  size: number;
  contentHash: string | null;
  createdAt: string;
  createdBy: string | null;
}

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

export interface FolderShare {
  id: string;
  folderId: string;
  sharedWith: string;
  accessLevel: 'view' | 'edit';
  createdAt: string;
  email?: string;
  name?: string;
}

export interface FolderContents {
  folder: FileItem | null;
  items: FileItem[];
  breadcrumbs: Array<{ id: string; name: string }>;
}

export interface UploadSession {
  uploadSessionId: string;
  chunksNeeded: string[];
  totalChunks: number;
}

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
