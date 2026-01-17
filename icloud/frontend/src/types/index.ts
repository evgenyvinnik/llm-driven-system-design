// User types
export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  storageQuota: number;
  storageUsed: number;
}

export interface AuthState {
  user: User | null;
  deviceId: string | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
}

// File types
export interface FileItem {
  id: string;
  name: string;
  path: string;
  mimeType?: string;
  size: number;
  contentHash?: string;
  versionVector: VersionVector;
  isFolder: boolean;
  isDeleted: boolean;
  createdAt: string;
  modifiedAt: string;
  syncStatus?: SyncStatus;
}

export interface VersionVector {
  [deviceId: string]: number;
}

export type SyncStatus = 'synced' | 'syncing' | 'pending' | 'conflict' | 'error';

export interface FileVersion {
  id: string;
  versionNumber: number;
  contentHash: string;
  versionVector: VersionVector;
  deviceName?: string;
  isConflict: boolean;
  conflictResolved: boolean;
  createdAt: string;
}

export interface Conflict {
  id: string;
  fileId: string;
  fileName: string;
  filePath: string;
  versionNumber: number;
  contentHash: string;
  versionVector: VersionVector;
  deviceName?: string;
  createdAt: string;
}

// Photo types
export interface Photo {
  id: string;
  thumbnailUrl: string;
  previewUrl: string;
  width: number;
  height: number;
  takenAt?: string;
  location?: {
    lat: number;
    lng: number;
  };
  isFavorite: boolean;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface Album {
  id: string;
  name: string;
  isShared: boolean;
  photoCount: number;
  coverUrl?: string;
  createdAt: string;
  updatedAt: string;
}

// Device types
export interface Device {
  id: string;
  name: string;
  deviceType: 'iphone' | 'ipad' | 'mac' | 'web';
  lastSyncAt?: string;
  syncCursor?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  isConnected?: boolean;
}

// Sync types
export interface SyncState {
  deviceId: string;
  lastSyncAt?: string;
  syncCursor?: Record<string, unknown>;
}

export interface SyncChange {
  fileId: string;
  operation: 'create' | 'update' | 'delete';
  path: string;
  name?: string;
  contentHash?: string;
  versionVector: VersionVector;
  mimeType?: string;
  size?: number;
}

export interface SyncResult {
  applied: SyncChange[];
  conflicts: Conflict[];
  errors: { fileId: string; error: string }[];
}

export interface DeltaSync {
  fileId: string;
  totalChunks: number;
  chunksToDownload: ChunkInfo[];
  chunksToKeep: ChunkInfo[];
  bytesToDownload: number;
}

export interface ChunkInfo {
  index: number;
  hash: string;
  size?: number;
}

// Admin types
export interface SystemStats {
  users: {
    total: number;
    new24h: number;
    storageUsed: number;
    storageQuota: number;
  };
  files: {
    total: number;
    folders: number;
    totalSize: number;
    deleted: number;
  };
  photos: {
    total: number;
    favorites: number;
    deleted: number;
  };
  devices: {
    total: number;
    active24h: number;
    active7d: number;
  };
  sync: {
    operations24h: number;
    completed: number;
    failed: number;
    conflicts: number;
  };
  chunks: {
    total: number;
    storageUsed: number;
    dedupSavings: number;
  };
}

export interface SyncOperation {
  id: string;
  userId: string;
  userEmail: string;
  deviceId?: string;
  deviceName?: string;
  fileId?: string;
  fileName?: string;
  filePath?: string;
  operationType: string;
  status: string;
  operationData?: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
}

// WebSocket message types
export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export interface WSFileEvent extends WSMessage {
  type: 'file_created' | 'file_updated' | 'file_deleted';
  file: Partial<FileItem>;
  sourceDevice?: string;
}

export interface WSPhotoEvent extends WSMessage {
  type: 'photo_added' | 'photo_updated' | 'photo_deleted';
  photo: Partial<Photo>;
}

export interface WSConflictEvent extends WSMessage {
  type: 'conflict_resolved';
  fileId: string;
  resolution: string;
}
