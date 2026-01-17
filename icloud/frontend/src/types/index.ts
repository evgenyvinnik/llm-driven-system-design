/**
 * Type definitions for the iCloud Sync frontend application.
 *
 * These types mirror the backend API responses and are used throughout
 * the frontend for type safety. They define the core domain models for
 * users, files, photos, devices, and sync operations.
 */

// User types

/**
 * Represents an authenticated user in the system.
 */
export interface User {
  /** Unique user identifier (UUID) */
  id: string;
  /** User's email address */
  email: string;
  /** User's role determining permissions */
  role: 'user' | 'admin';
  /** Total storage quota in bytes */
  storageQuota: number;
  /** Current storage usage in bytes */
  storageUsed: number;
}

/**
 * Authentication state tracked in the auth store.
 */
export interface AuthState {
  /** Currently authenticated user or null if logged out */
  user: User | null;
  /** Current device's unique identifier for sync tracking */
  deviceId: string | null;
  /** Session token for WebSocket authentication */
  token: string | null;
  /** Whether an auth operation is in progress */
  isLoading: boolean;
  /** Error message from the last failed auth operation */
  error: string | null;
}

// File types

/**
 * Represents a file or folder in iCloud Drive.
 *
 * Contains metadata for display and sync, including version vectors
 * for conflict detection and sync status for UI feedback.
 */
export interface FileItem {
  /** Unique file identifier (UUID) */
  id: string;
  /** Display name of the file or folder */
  name: string;
  /** Full path from root (e.g., "/Documents/Work") */
  path: string;
  /** MIME type for files (undefined for folders) */
  mimeType?: string;
  /** File size in bytes (0 for folders) */
  size: number;
  /** SHA-256 hash of file content for change detection */
  contentHash?: string;
  /** Version vector tracking modifications per device */
  versionVector: VersionVector;
  /** Whether this item is a folder */
  isFolder: boolean;
  /** Whether the file is soft-deleted (in trash) */
  isDeleted: boolean;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last modification */
  modifiedAt: string;
  /** Current sync status for UI display */
  syncStatus?: SyncStatus;
}

/**
 * Version vector for tracking file modifications across devices.
 *
 * Each entry maps a device ID to its latest known sequence number
 * for this file. Used to detect conflicts when vectors diverge.
 */
export interface VersionVector {
  [deviceId: string]: number;
}

/**
 * Possible sync states for a file in the UI.
 */
export type SyncStatus = 'synced' | 'syncing' | 'pending' | 'conflict' | 'error';

/**
 * Represents a specific version of a file in the version history.
 */
export interface FileVersion {
  /** Unique version identifier */
  id: string;
  /** Sequential version number (1, 2, 3, ...) */
  versionNumber: number;
  /** Content hash at this version */
  contentHash: string;
  /** Version vector at time of creation */
  versionVector: VersionVector;
  /** Friendly name of the device that created this version */
  deviceName?: string;
  /** Whether this version represents a conflict copy */
  isConflict: boolean;
  /** Whether the conflict has been resolved */
  conflictResolved: boolean;
  /** ISO timestamp of version creation */
  createdAt: string;
}

/**
 * Represents an unresolved sync conflict requiring user action.
 */
export interface Conflict {
  /** Unique conflict identifier */
  id: string;
  /** ID of the file with the conflict */
  fileId: string;
  /** Name of the conflicted file */
  fileName: string;
  /** Path to the conflicted file */
  filePath: string;
  /** Version number of the conflicting version */
  versionNumber: number;
  /** Content hash of the conflicting version */
  contentHash: string;
  /** Version vector of the conflicting version */
  versionVector: VersionVector;
  /** Device that created the conflicting version */
  deviceName?: string;
  /** When the conflict was detected */
  createdAt: string;
}

// Photo types

/**
 * Represents a photo in the iCloud Photos library.
 *
 * Photos are stored with multiple derivatives (thumbnail, preview, full)
 * for efficient loading at different sizes.
 */
export interface Photo {
  /** Unique photo identifier */
  id: string;
  /** URL to the small thumbnail (200px) for grid display */
  thumbnailUrl: string;
  /** URL to the medium preview (1024px) for lightbox */
  previewUrl: string;
  /** Original image width in pixels */
  width: number;
  /** Original image height in pixels */
  height: number;
  /** When the photo was taken (from EXIF) */
  takenAt?: string;
  /** GPS coordinates where photo was taken (from EXIF) */
  location?: {
    lat: number;
    lng: number;
  };
  /** Whether the user has marked this photo as a favorite */
  isFavorite: boolean;
  /** When the photo was uploaded to iCloud */
  createdAt: string;
  /** Additional EXIF and processing metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Represents a photo album for organization.
 */
export interface Album {
  /** Unique album identifier */
  id: string;
  /** Display name of the album */
  name: string;
  /** Whether the album is shared with other users */
  isShared: boolean;
  /** Number of photos in the album */
  photoCount: number;
  /** URL to the album's cover photo thumbnail */
  coverUrl?: string;
  /** When the album was created */
  createdAt: string;
  /** When photos were last added or removed */
  updatedAt: string;
}

// Device types

/**
 * Represents a registered device participating in sync.
 *
 * Each device gets a unique ID that appears in version vectors
 * to track which devices have seen which file versions.
 */
export interface Device {
  /** Unique device identifier (UUID) */
  id: string;
  /** User-friendly device name */
  name: string;
  /** Device category for icon display */
  deviceType: 'iphone' | 'ipad' | 'mac' | 'web';
  /** When this device last synced */
  lastSyncAt?: string;
  /** Sync cursor for resuming incremental sync */
  syncCursor?: Record<string, unknown>;
  /** When the device was registered */
  createdAt: string;
  /** When device info was last updated */
  updatedAt?: string;
  /** Whether the device has an active WebSocket connection */
  isConnected?: boolean;
}

// Sync types

/**
 * Current sync state for a device.
 *
 * Used to resume incremental sync from the last known position.
 */
export interface SyncState {
  /** Device this state belongs to */
  deviceId: string;
  /** When the device last completed a sync */
  lastSyncAt?: string;
  /** Cursor for fetching changes since last sync */
  syncCursor?: Record<string, unknown>;
}

/**
 * Represents a local file change to push to the server.
 */
export interface SyncChange {
  /** ID of the file being changed */
  fileId: string;
  /** Type of operation performed */
  operation: 'create' | 'update' | 'delete';
  /** Full path of the file */
  path: string;
  /** File name (for create/update) */
  name?: string;
  /** New content hash (for create/update) */
  contentHash?: string;
  /** Local version vector to compare for conflicts */
  versionVector: VersionVector;
  /** MIME type (for create/update) */
  mimeType?: string;
  /** File size in bytes (for create/update) */
  size?: number;
}

/**
 * Result of pushing local changes to the server.
 */
export interface SyncResult {
  /** Changes that were successfully applied */
  applied: SyncChange[];
  /** Conflicts detected during push */
  conflicts: Conflict[];
  /** Errors that occurred for specific files */
  errors: { fileId: string; error: string }[];
}

/**
 * Delta sync information for efficient file transfer.
 *
 * Compares chunk hashes to determine which parts of a file
 * need to be transferred, minimizing bandwidth for large files.
 */
export interface DeltaSync {
  /** ID of the file being synced */
  fileId: string;
  /** Total number of chunks in the server version */
  totalChunks: number;
  /** Chunks that need to be downloaded from server */
  chunksToDownload: ChunkInfo[];
  /** Chunks that can be reused from local storage */
  chunksToKeep: ChunkInfo[];
  /** Total bytes that need to be downloaded */
  bytesToDownload: number;
}

/**
 * Information about a single chunk of a file.
 */
export interface ChunkInfo {
  /** Position of the chunk in the file (0-indexed) */
  index: number;
  /** SHA-256 hash of the chunk content */
  hash: string;
  /** Size of the chunk in bytes */
  size?: number;
}

// Admin types

/**
 * Aggregated system statistics for the admin dashboard.
 *
 * Provides a high-level overview of system health and usage.
 */
export interface SystemStats {
  /** User-related statistics */
  users: {
    /** Total registered users */
    total: number;
    /** Users registered in the last 24 hours */
    new24h: number;
    /** Total storage used across all users in bytes */
    storageUsed: number;
    /** Total storage quota across all users in bytes */
    storageQuota: number;
  };
  /** File storage statistics */
  files: {
    /** Total number of files */
    total: number;
    /** Total number of folders */
    folders: number;
    /** Total size of all files in bytes */
    totalSize: number;
    /** Number of soft-deleted files */
    deleted: number;
  };
  /** Photo library statistics */
  photos: {
    /** Total number of photos */
    total: number;
    /** Number of favorited photos */
    favorites: number;
    /** Number of soft-deleted photos */
    deleted: number;
  };
  /** Device statistics */
  devices: {
    /** Total registered devices */
    total: number;
    /** Devices active in the last 24 hours */
    active24h: number;
    /** Devices active in the last 7 days */
    active7d: number;
  };
  /** Sync operation statistics */
  sync: {
    /** Sync operations in the last 24 hours */
    operations24h: number;
    /** Successfully completed operations */
    completed: number;
    /** Failed operations */
    failed: number;
    /** Unresolved conflicts */
    conflicts: number;
  };
  /** Chunk storage and deduplication statistics */
  chunks: {
    /** Total number of unique chunks */
    total: number;
    /** Storage used by chunks in bytes */
    storageUsed: number;
    /** Storage saved by deduplication in bytes */
    dedupSavings: number;
  };
}

/**
 * Record of a sync operation for audit and debugging.
 */
export interface SyncOperation {
  /** Unique operation identifier */
  id: string;
  /** User who performed the operation */
  userId: string;
  /** Email of the user (for display) */
  userEmail: string;
  /** Device that initiated the operation */
  deviceId?: string;
  /** Friendly name of the device */
  deviceName?: string;
  /** ID of the affected file */
  fileId?: string;
  /** Name of the affected file */
  fileName?: string;
  /** Path to the affected file */
  filePath?: string;
  /** Type of operation (create, update, delete, etc.) */
  operationType: string;
  /** Current status (pending, completed, failed) */
  status: string;
  /** Additional operation metadata */
  operationData?: Record<string, unknown>;
  /** When the operation was initiated */
  createdAt: string;
  /** When the operation completed (if applicable) */
  completedAt?: string;
}

// WebSocket message types

/**
 * Base interface for all WebSocket messages.
 */
export interface WSMessage {
  /** Message type identifier */
  type: string;
  /** Additional message payload (varies by type) */
  [key: string]: unknown;
}

/**
 * WebSocket event for file changes (create, update, delete).
 */
export interface WSFileEvent extends WSMessage {
  /** Specific file event type */
  type: 'file_created' | 'file_updated' | 'file_deleted';
  /** Partial file data for the affected file */
  file: Partial<FileItem>;
  /** Device that originated the change (to avoid self-notification) */
  sourceDevice?: string;
}

/**
 * WebSocket event for photo changes (add, update, delete).
 */
export interface WSPhotoEvent extends WSMessage {
  /** Specific photo event type */
  type: 'photo_added' | 'photo_updated' | 'photo_deleted';
  /** Partial photo data for the affected photo */
  photo: Partial<Photo>;
}

/**
 * WebSocket event for conflict resolution.
 */
export interface WSConflictEvent extends WSMessage {
  /** Event type for conflict resolution */
  type: 'conflict_resolved';
  /** ID of the file whose conflict was resolved */
  fileId: string;
  /** How the conflict was resolved */
  resolution: string;
}
