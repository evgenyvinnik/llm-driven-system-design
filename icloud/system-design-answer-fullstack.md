# iCloud Sync - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement (1 minute)

"I'll design iCloud, a file and photo synchronization service that keeps data consistent across all Apple devices. As a full-stack engineer, I'll focus on the end-to-end sync flow: how version vectors on the backend coordinate with client-side state to detect conflicts, how chunk-based uploads integrate with offline queuing on the frontend, and how real-time WebSocket notifications keep all devices in sync.

The key integration challenges are: designing a shared type system for sync state that works on both ends, building an offline-first client that gracefully handles sync operations when reconnecting, and implementing idempotent APIs that support client retries without duplicate processing."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **File Sync**: Synchronize files and folders across devices (Mac, iPhone, iPad, Web)
- **Photo Library**: Store and sync photo library with smart storage optimization
- **Conflict Resolution**: Detect and resolve edit conflicts automatically when possible
- **Offline Support**: Full functionality offline, sync when reconnected
- **Sharing**: Share files and photo albums with other users

### Non-Functional Requirements
- **Consistency**: Eventual consistency with reliable conflict detection
- **Latency**: < 5 seconds for sync propagation to other devices
- **Offline-first**: Core features work without network
- **Performance**: 60fps scrolling through 10,000+ photos

### Scale Estimates
- **Users**: 1 billion+ Apple IDs
- **Devices per user**: 3-5 average
- **Storage per user**: 50GB average
- **Sync events**: Billions per day globally

## High-Level Architecture (5 minutes)

```
+---------------------------------------------------------------+
|                      Frontend (React)                          |
|                                                                |
|  +------------------+  +------------------+  +---------------+ |
|  |   File Browser   |  |  Photo Gallery   |  | Admin Panel   | |
|  +------------------+  +------------------+  +---------------+ |
|                              |                                 |
|  +----------------------------------------------------------+ |
|  |                 Zustand Stores                            | |
|  | +-------------+  +-------------+  +--------------------+  | |
|  | | File Store  |  | Photo Store |  | Sync State Store   |  | |
|  | +-------------+  +-------------+  +--------------------+  | |
|  +----------------------------------------------------------+ |
|                              |                                 |
|  +----------------------------------------------------------+ |
|  |    Sync Engine + Offline Queue + IndexedDB               | |
|  +----------------------------------------------------------+ |
+---------------------------------------------------------------+
                              |
                              | REST + WebSocket
                              v
+---------------------------------------------------------------+
|                      Backend (Node.js)                         |
|                                                                |
|  +----------------------------------------------------------+ |
|  |                    API Gateway                            | |
|  +----------------------------------------------------------+ |
|        |                    |                    |             |
|        v                    v                    v             |
|  +-------------+    +---------------+    +---------------+     |
|  | Sync Service|    | Photo Service |    | WebSocket Hub |     |
|  +-------------+    +---------------+    +---------------+     |
|        |                    |                    |             |
+---------------------------------------------------------------+
                              |
+---------------------------------------------------------------+
|                       Data Layer                               |
|  +---------------+  +---------------+  +------------------+    |
|  |  PostgreSQL   |  |    MinIO      |  |    Valkey        |    |
|  |  - Metadata   |  |  - Chunks     |  |  - Sessions      |    |
|  |  - Versions   |  |  - Photos     |  |  - Sync cursors  |    |
|  +---------------+  +---------------+  +------------------+    |
+---------------------------------------------------------------+
```

## Deep Dive: Shared Type System (8 minutes)

A single source of truth for types ensures frontend and backend stay synchronized.

### Shared Types Definition

```typescript
// shared/types.ts

// Version vector for conflict detection
export interface VersionVector {
  [deviceId: string]: number;
}

// Sync status enum used on both ends
export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'conflict' | 'error';

// File item shared between frontend and backend
export interface FileItem {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'folder';
  size: number;
  contentHash: string | null;
  version: VersionVector;
  isDeleted: boolean;
  createdAt: string;
  modifiedAt: string;
}

// Frontend extends with local state
export interface ClientFileItem extends FileItem {
  syncStatus: SyncStatus;
  localModifiedAt?: string;
  pendingOperationId?: string;
}

// Sync operation request
export interface SyncPushRequest {
  deviceId: string;
  lastSyncToken: string | null;
  changes: FileChange[];
}

export interface FileChange {
  type: 'create' | 'update' | 'delete' | 'move';
  fileId: string;
  data?: Partial<FileItem>;
  newPath?: string;  // for move operations
}

// Sync operation response
export interface SyncPushResponse {
  syncToken: string;
  applied: FileChange[];
  conflicts: ConflictInfo[];
  errors: SyncError[];
}

export interface ConflictInfo {
  id: string;
  fileId: string;
  fileName: string;
  localVersion: VersionVector;
  serverVersion: VersionVector;
  localModifiedBy: string;
  serverModifiedBy: string;
  localModifiedAt: string;
  serverModifiedAt: string;
}

export interface SyncError {
  fileId: string;
  code: string;
  message: string;
  retryable: boolean;
}

// Photo types
export interface Photo {
  id: string;
  userId: string;
  hash: string;
  filename: string;
  takenAt: string | null;
  location: { lat: number; lng: number } | null;
  width: number;
  height: number;
  fullResSize: number;
  derivatives: PhotoDerivatives;
  metadata: Record<string, unknown>;
  syncStatus: SyncStatus;
  isDeleted: boolean;
}

export interface PhotoDerivatives {
  thumbnail: string;  // 200px URL
  preview: string;    // 1024px URL
  display: string;    // 2048px URL
}

// Chunk upload types
export interface ChunkManifest {
  fileId: string;
  totalSize: number;
  chunkSize: number;
  chunks: ChunkInfo[];
  version: VersionVector;
}

export interface ChunkInfo {
  index: number;
  hash: string;
  size: number;
  uploaded: boolean;
}

// WebSocket event types
export type WSEventType = 'file_changed' | 'file_deleted' | 'conflict_detected' | 'sync_complete';

export interface WSEvent {
  type: WSEventType;
  payload: unknown;
  timestamp: string;
  sourceDeviceId: string;
}

// API response wrapper
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}
```

### Frontend Store Using Shared Types

```typescript
// stores/fileStore.ts
import type {
  ClientFileItem,
  SyncPushRequest,
  SyncPushResponse,
  FileChange,
  ConflictInfo
} from '@shared/types';

interface FileStore {
  files: Map<string, ClientFileItem>;
  pendingChanges: FileChange[];
  conflicts: ConflictInfo[];
  lastSyncToken: string | null;
  deviceId: string;

  pushChanges: () => Promise<SyncPushResponse>;
  applyServerChanges: (changes: FileChange[]) => void;
  handleConflicts: (conflicts: ConflictInfo[]) => void;
}

export const useFileStore = create<FileStore>()((set, get) => ({
  files: new Map(),
  pendingChanges: [],
  conflicts: [],
  lastSyncToken: null,
  deviceId: getOrCreateDeviceId(),

  pushChanges: async () => {
    const { deviceId, lastSyncToken, pendingChanges } = get();

    const request: SyncPushRequest = {
      deviceId,
      lastSyncToken,
      changes: pendingChanges
    };

    // Mark files as syncing
    set((state) => {
      const files = new Map(state.files);
      for (const change of pendingChanges) {
        const file = files.get(change.fileId);
        if (file) {
          files.set(change.fileId, { ...file, syncStatus: 'syncing' });
        }
      }
      return { files };
    });

    const response = await api.post<SyncPushResponse>('/api/v1/sync/push', request);

    // Update state based on response
    set((state) => {
      const files = new Map(state.files);

      // Mark applied changes as synced
      for (const applied of response.applied) {
        const file = files.get(applied.fileId);
        if (file) {
          files.set(applied.fileId, { ...file, syncStatus: 'synced' });
        }
      }

      // Mark errors
      for (const error of response.errors) {
        const file = files.get(error.fileId);
        if (file) {
          files.set(error.fileId, { ...file, syncStatus: 'error' });
        }
      }

      // Remove applied changes from pending
      const appliedIds = new Set(response.applied.map(a => a.fileId));
      const remainingChanges = state.pendingChanges.filter(
        c => !appliedIds.has(c.fileId)
      );

      return {
        files,
        pendingChanges: remainingChanges,
        conflicts: [...state.conflicts, ...response.conflicts],
        lastSyncToken: response.syncToken
      };
    });

    return response;
  }
}));
```

### Backend Sync Service Using Shared Types

```typescript
// backend/src/sync/syncService.ts
import type {
  SyncPushRequest,
  SyncPushResponse,
  FileChange,
  ConflictInfo,
  VersionVector
} from '@shared/types';

export class SyncService {
  async processPush(
    userId: string,
    request: SyncPushRequest
  ): Promise<SyncPushResponse> {
    const { deviceId, lastSyncToken, changes } = request;

    const applied: FileChange[] = [];
    const conflicts: ConflictInfo[] = [];
    const errors: SyncError[] = [];

    await db.transaction(async (tx) => {
      for (const change of changes) {
        try {
          const result = await this.applyChange(tx, userId, deviceId, change);

          if (result.conflict) {
            conflicts.push(result.conflict);
          } else {
            applied.push(change);
          }
        } catch (error) {
          errors.push({
            fileId: change.fileId,
            code: 'APPLY_FAILED',
            message: error.message,
            retryable: true
          });
        }
      }
    });

    // Generate new sync token
    const syncToken = this.generateSyncToken(userId, deviceId);

    // Update device sync state
    await this.updateDeviceSyncState(userId, deviceId, syncToken);

    // Notify other devices via WebSocket
    await this.notifyOtherDevices(userId, deviceId, applied);

    return { syncToken, applied, conflicts, errors };
  }

  private async applyChange(
    tx: Transaction,
    userId: string,
    deviceId: string,
    change: FileChange
  ): Promise<{ conflict?: ConflictInfo }> {
    const serverFile = await tx.query(
      'SELECT * FROM files WHERE id = $1 AND user_id = $2',
      [change.fileId, userId]
    );

    if (change.type === 'create' && !serverFile.rows[0]) {
      // New file, no conflict possible
      await this.createFile(tx, userId, deviceId, change);
      return {};
    }

    if (change.type === 'update' || change.type === 'delete') {
      const serverVersion = serverFile.rows[0]?.version || {};
      const clientVersion = change.data?.version || {};

      const comparison = this.compareVersions(clientVersion, serverVersion);

      if (comparison === 'conflict') {
        return {
          conflict: this.buildConflictInfo(
            change.fileId,
            serverFile.rows[0],
            change,
            deviceId
          )
        };
      }

      // Apply the change
      await this.updateFile(tx, userId, deviceId, change);
    }

    return {};
  }

  compareVersions(
    clientVersion: VersionVector,
    serverVersion: VersionVector
  ): 'client-newer' | 'server-newer' | 'equal' | 'conflict' {
    let clientNewer = false;
    let serverNewer = false;

    const allDevices = new Set([
      ...Object.keys(clientVersion),
      ...Object.keys(serverVersion)
    ]);

    for (const device of allDevices) {
      const clientSeq = clientVersion[device] || 0;
      const serverSeq = serverVersion[device] || 0;

      if (clientSeq > serverSeq) clientNewer = true;
      if (serverSeq > clientSeq) serverNewer = true;
    }

    if (clientNewer && serverNewer) return 'conflict';
    if (clientNewer) return 'client-newer';
    if (serverNewer) return 'server-newer';
    return 'equal';
  }
}
```

## Deep Dive: Chunked Upload Flow (10 minutes)

The chunked upload demonstrates tight frontend-backend integration.

### Backend Chunk Upload Endpoints

```typescript
// backend/src/routes/files.ts
import type { ChunkManifest, ChunkInfo } from '@shared/types';

router.post('/files/:fileId/upload/init', async (req, res) => {
  const { fileId } = req.params;
  const { fileName, totalSize, chunkSize, totalChunks } = req.body;
  const userId = req.session.userId;

  // Create upload session
  const uploadId = crypto.randomUUID();

  await redis.setex(
    `upload:${uploadId}`,
    3600, // 1 hour TTL
    JSON.stringify({
      fileId,
      userId,
      fileName,
      totalSize,
      chunkSize,
      totalChunks,
      uploadedChunks: []
    })
  );

  res.json({ uploadId, chunkSize, totalChunks });
});

router.put('/files/:fileId/upload/:uploadId/chunk/:index', async (req, res) => {
  const { fileId, uploadId, index } = req.params;
  const chunkIndex = parseInt(index, 10);
  const userId = req.session.userId;

  const sessionData = await redis.get(`upload:${uploadId}`);
  if (!sessionData) {
    return res.status(404).json({ error: 'Upload session expired' });
  }

  const session = JSON.parse(sessionData);

  // Compute chunk hash
  const chunkData = req.body;
  const hash = crypto.createHash('sha256').update(chunkData).digest('hex');

  // Check if chunk already exists (deduplication)
  const existingChunk = await db.query(
    'SELECT hash FROM chunk_store WHERE hash = $1',
    [hash]
  );

  if (!existingChunk.rows[0]) {
    // Upload to MinIO
    await minioClient.putObject('chunks', hash, chunkData);

    // Add to chunk store
    await db.query(`
      INSERT INTO chunk_store (hash, size, reference_count)
      VALUES ($1, $2, 1)
    `, [hash, chunkData.length]);
  } else {
    // Increment reference count
    await db.query(`
      UPDATE chunk_store SET reference_count = reference_count + 1
      WHERE hash = $1
    `, [hash]);
  }

  // Track chunk in session
  session.uploadedChunks.push({ index: chunkIndex, hash, size: chunkData.length });
  await redis.setex(`upload:${uploadId}`, 3600, JSON.stringify(session));

  const progress = session.uploadedChunks.length / session.totalChunks;
  res.json({ chunkIndex, hash, progress });
});

router.post('/files/:fileId/upload/:uploadId/complete', async (req, res) => {
  const { fileId, uploadId } = req.params;
  const userId = req.session.userId;
  const deviceId = req.body.deviceId;

  const sessionData = await redis.get(`upload:${uploadId}`);
  if (!sessionData) {
    return res.status(404).json({ error: 'Upload session expired' });
  }

  const session = JSON.parse(sessionData);

  // Verify all chunks uploaded
  if (session.uploadedChunks.length !== session.totalChunks) {
    return res.status(400).json({
      error: 'Missing chunks',
      uploaded: session.uploadedChunks.length,
      expected: session.totalChunks
    });
  }

  // Sort chunks by index
  const orderedChunks = session.uploadedChunks.sort(
    (a: ChunkInfo, b: ChunkInfo) => a.index - b.index
  );

  // Compute file hash from chunk hashes
  const fileHash = crypto.createHash('sha256')
    .update(orderedChunks.map((c: ChunkInfo) => c.hash).join(''))
    .digest('hex');

  // Create/update file record
  await db.query(`
    INSERT INTO files (id, user_id, name, path, size, content_hash, version)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      size = $5,
      content_hash = $6,
      version = jsonb_set(files.version, ARRAY[$8], to_jsonb((COALESCE((files.version->>$8)::int, 0) + 1))),
      modified_at = NOW()
  `, [fileId, userId, session.fileName, session.filePath, session.totalSize,
      fileHash, JSON.stringify({ [deviceId]: 1 }), deviceId]);

  // Create chunk references
  for (const chunk of orderedChunks) {
    await db.query(`
      INSERT INTO file_chunks (file_id, chunk_index, chunk_hash, chunk_size)
      VALUES ($1, $2, $3, $4)
    `, [fileId, chunk.index, chunk.hash, chunk.size]);
  }

  // Clean up session
  await redis.del(`upload:${uploadId}`);

  // Notify other devices
  await websocketHub.broadcast(userId, deviceId, {
    type: 'file_changed',
    payload: { fileId, action: 'uploaded' }
  });

  res.json({ fileId, hash: fileHash, size: session.totalSize });
});
```

### Frontend Chunked Uploader

```typescript
// services/chunkedUploader.ts
import type { ChunkManifest, ChunkInfo } from '@shared/types';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB

export class ChunkedUploader {
  private uploadId: string | null = null;
  private onProgress: ((progress: number) => void) | null = null;

  async uploadFile(
    file: File,
    path: string,
    options?: { onProgress?: (progress: number) => void }
  ): Promise<{ fileId: string; hash: string }> {
    this.onProgress = options?.onProgress || null;

    const fileId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Initialize upload session
    const initResponse = await api.post(`/api/v1/files/${fileId}/upload/init`, {
      fileName: file.name,
      filePath: `${path}/${file.name}`,
      totalSize: file.size,
      chunkSize: CHUNK_SIZE,
      totalChunks
    });

    this.uploadId = initResponse.uploadId;

    // Upload chunks with retry
    const uploadedChunks: ChunkInfo[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      const chunkResult = await this.uploadChunkWithRetry(fileId, i, chunk);
      uploadedChunks.push(chunkResult);

      this.onProgress?.((i + 1) / totalChunks);
    }

    // Complete upload
    const result = await api.post(`/api/v1/files/${fileId}/upload/${this.uploadId}/complete`, {
      deviceId: getDeviceId()
    });

    return { fileId: result.fileId, hash: result.hash };
  }

  private async uploadChunkWithRetry(
    fileId: string,
    index: number,
    chunk: Blob,
    maxRetries = 3
  ): Promise<ChunkInfo> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(
          `/api/v1/files/${fileId}/upload/${this.uploadId}/chunk/${index}`,
          {
            method: 'PUT',
            body: chunk,
            headers: {
              'Content-Type': 'application/octet-stream'
            }
          }
        );

        if (!response.ok) {
          throw new Error(`Upload failed: ${response.status}`);
        }

        return await response.json();
      } catch (error) {
        lastError = error as Error;

        if (attempt < maxRetries - 1) {
          // Exponential backoff
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError;
  }

  // Resume interrupted upload
  async resumeUpload(uploadId: string, file: File): Promise<{ fileId: string; hash: string }> {
    // Get upload session status
    const session = await api.get(`/api/v1/uploads/${uploadId}/status`);

    const uploadedIndices = new Set(session.uploadedChunks.map((c: ChunkInfo) => c.index));
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Upload missing chunks
    for (let i = 0; i < totalChunks; i++) {
      if (uploadedIndices.has(i)) continue;

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      await this.uploadChunkWithRetry(session.fileId, i, chunk);

      this.onProgress?.((uploadedIndices.size + 1) / totalChunks);
      uploadedIndices.add(i);
    }

    // Complete upload
    return await api.post(`/api/v1/files/${session.fileId}/upload/${uploadId}/complete`, {
      deviceId: getDeviceId()
    });
  }
}
```

### Upload Progress Component

```typescript
// components/files/UploadProgress.tsx
interface UploadProgressProps {
  uploads: Array<{
    id: string;
    fileName: string;
    progress: number;
    status: 'uploading' | 'paused' | 'complete' | 'error';
  }>;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
}

export const UploadProgress: React.FC<UploadProgressProps> = ({
  uploads,
  onPause,
  onResume,
  onCancel
}) => {
  if (uploads.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 w-80 bg-white rounded-lg shadow-lg border p-4">
      <h3 className="font-medium mb-3 flex items-center gap-2">
        <Upload className="w-4 h-4" />
        Uploading {uploads.length} file{uploads.length > 1 ? 's' : ''}
      </h3>

      <div className="space-y-3 max-h-60 overflow-auto">
        {uploads.map((upload) => (
          <div key={upload.id} className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm truncate flex-1">{upload.fileName}</span>
              <div className="flex gap-1">
                {upload.status === 'uploading' && (
                  <button
                    onClick={() => onPause(upload.id)}
                    className="p-1 hover:bg-gray-100 rounded"
                  >
                    <Pause className="w-4 h-4" />
                  </button>
                )}
                {upload.status === 'paused' && (
                  <button
                    onClick={() => onResume(upload.id)}
                    className="p-1 hover:bg-gray-100 rounded"
                  >
                    <Play className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => onCancel(upload.id)}
                  className="p-1 hover:bg-gray-100 rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="h-1 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full transition-all',
                  upload.status === 'error' ? 'bg-red-500' : 'bg-blue-500'
                )}
                style={{ width: `${upload.progress * 100}%` }}
              />
            </div>

            <span className="text-xs text-gray-500">
              {upload.status === 'error'
                ? 'Failed - click to retry'
                : `${Math.round(upload.progress * 100)}%`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
```

## Deep Dive: WebSocket Real-Time Sync (8 minutes)

### Backend WebSocket Hub

```typescript
// backend/src/websocket/hub.ts
import { WebSocketServer, WebSocket } from 'ws';
import type { WSEvent, WSEventType } from '@shared/types';

interface ConnectedClient {
  socket: WebSocket;
  userId: string;
  deviceId: string;
}

class WebSocketHub {
  private clients = new Map<string, Set<ConnectedClient>>();

  initialize(server: http.Server) {
    const wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', async (socket, req) => {
      const session = await this.authenticateConnection(req);
      if (!session) {
        socket.close(4001, 'Unauthorized');
        return;
      }

      const client: ConnectedClient = {
        socket,
        userId: session.userId,
        deviceId: session.deviceId
      };

      this.addClient(client);

      socket.on('close', () => this.removeClient(client));
      socket.on('error', () => this.removeClient(client));

      // Send initial sync state
      this.sendEvent(client, {
        type: 'sync_complete',
        payload: { connected: true },
        timestamp: new Date().toISOString(),
        sourceDeviceId: 'server'
      });
    });
  }

  private addClient(client: ConnectedClient) {
    if (!this.clients.has(client.userId)) {
      this.clients.set(client.userId, new Set());
    }
    this.clients.get(client.userId)!.add(client);

    logger.info('WebSocket client connected', {
      userId: client.userId,
      deviceId: client.deviceId,
      totalConnections: this.clients.get(client.userId)!.size
    });
  }

  private removeClient(client: ConnectedClient) {
    this.clients.get(client.userId)?.delete(client);
  }

  async broadcast(
    userId: string,
    sourceDeviceId: string,
    event: Omit<WSEvent, 'timestamp' | 'sourceDeviceId'>
  ) {
    const userClients = this.clients.get(userId);
    if (!userClients) return;

    const fullEvent: WSEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      sourceDeviceId
    };

    for (const client of userClients) {
      // Don't send to source device
      if (client.deviceId === sourceDeviceId) continue;

      this.sendEvent(client, fullEvent);
    }
  }

  private sendEvent(client: ConnectedClient, event: WSEvent) {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(event));
    }
  }
}

export const websocketHub = new WebSocketHub();
```

### Frontend WebSocket Client

```typescript
// services/websocketClient.ts
import type { WSEvent, WSEventType } from '@shared/types';

class WebSocketClient {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private listeners = new Map<WSEventType, Set<(payload: unknown) => void>>();

  connect(deviceId: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws?deviceId=${deviceId}`;

    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
    };

    this.socket.onmessage = (event) => {
      try {
        const wsEvent: WSEvent = JSON.parse(event.data);
        this.handleEvent(wsEvent);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    this.socket.onclose = () => {
      console.log('WebSocket disconnected');
      this.attemptReconnect(deviceId);
    };

    this.socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  private attemptReconnect(deviceId: string) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    setTimeout(() => {
      console.log(`Attempting reconnection ${this.reconnectAttempts}...`);
      this.connect(deviceId);
    }, delay);
  }

  private handleEvent(event: WSEvent) {
    const listeners = this.listeners.get(event.type);
    if (listeners) {
      for (const listener of listeners) {
        listener(event.payload);
      }
    }
  }

  on(eventType: WSEventType, callback: (payload: unknown) => void) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(eventType)?.delete(callback);
    };
  }

  disconnect() {
    this.socket?.close();
    this.socket = null;
  }
}

export const wsClient = new WebSocketClient();
```

### Integrating WebSocket with Store

```typescript
// stores/fileStore.ts - WebSocket integration
export const useFileStore = create<FileStore>()((set, get) => {
  // Initialize WebSocket listeners when store is created
  if (typeof window !== 'undefined') {
    wsClient.on('file_changed', (payload) => {
      const { fileId, action, file } = payload as {
        fileId: string;
        action: 'created' | 'updated' | 'deleted';
        file?: ClientFileItem;
      };

      set((state) => {
        const files = new Map(state.files);

        if (action === 'deleted') {
          files.delete(fileId);
        } else if (file) {
          files.set(fileId, { ...file, syncStatus: 'synced' });
        }

        return { files };
      });
    });

    wsClient.on('conflict_detected', (payload) => {
      const conflict = payload as ConflictInfo;
      set((state) => ({
        conflicts: [...state.conflicts, conflict]
      }));
    });
  }

  return {
    // ... rest of store
  };
});
```

## Trade-offs and Alternatives (5 minutes)

### 1. Shared Types: Runtime Validation vs. Build-Time Only

| Approach | Pros | Cons |
|----------|------|------|
| Build-time only (TypeScript) | Zero runtime cost | No runtime validation |
| Zod + TypeScript | Runtime validation | Bundle size + overhead |

**Chose hybrid**: TypeScript for internal types, Zod for API boundaries where untrusted data enters.

### 2. WebSocket vs. Server-Sent Events

| Approach | Pros | Cons |
|----------|------|------|
| WebSocket | Bidirectional | More complex |
| SSE | Simpler, auto-reconnect | Unidirectional |

**Chose WebSocket**: Need bidirectional communication for sync acknowledgments and conflict resolution.

### 3. Chunked Upload: Parallel vs. Sequential

| Approach | Pros | Cons |
|----------|------|------|
| Sequential | Simple, ordered | Slower |
| Parallel (3-5 chunks) | Faster | Complex tracking |

**Chose Sequential initially**: Simpler implementation. Would add parallel uploads as optimization.

### Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Type sharing | @shared/types | Code generation | Simplicity |
| Real-time | WebSocket | SSE | Bidirectional sync |
| Chunk upload | Sequential | Parallel | Implementation simplicity |
| Conflict UI | Modal | Inline | Clear user focus |

## API Contract (3 minutes)

```typescript
// API Endpoints

// Sync Operations
POST /api/v1/sync/push
  Request: SyncPushRequest
  Response: SyncPushResponse

GET /api/v1/sync/pull
  Query: { lastSyncToken: string; deviceId: string }
  Response: { changes: FileChange[]; syncToken: string }

// File Operations
POST /api/v1/files/:fileId/upload/init
  Request: { fileName, totalSize, chunkSize }
  Response: { uploadId, totalChunks }

PUT /api/v1/files/:fileId/upload/:uploadId/chunk/:index
  Request: Binary chunk data
  Response: { chunkIndex, hash, progress }

POST /api/v1/files/:fileId/upload/:uploadId/complete
  Request: { deviceId }
  Response: { fileId, hash, size }

GET /api/v1/files/:fileId/download
  Response: Binary file data (reconstructed from chunks)

// Conflict Resolution
GET /api/v1/conflicts
  Response: { conflicts: ConflictInfo[] }

POST /api/v1/conflicts/:conflictId/resolve
  Request: { resolution: 'local' | 'server' | 'both' }
  Response: { resolved: true; resultFileId: string }

// Photos
GET /api/v1/photos
  Query: { cursor?, limit? }
  Response: { photos: Photo[]; nextCursor?: string }

POST /api/v1/photos/upload
  Request: FormData with photo file
  Response: { photoId, derivatives }
```

## Closing Summary (1 minute)

"The iCloud full-stack architecture is built around three core integration points:

1. **Shared type system** with `@shared/types` - ensuring frontend and backend stay synchronized with the same interfaces for sync state, conflicts, and file operations
2. **Chunked upload with resume capability** - tight frontend-backend coordination with upload sessions tracked in Redis and progress updates flowing back to the UI
3. **WebSocket real-time sync** - bidirectional communication that notifies all devices of changes and enables immediate conflict detection

The key trade-off throughout is simplicity vs. optimization. We chose sequential chunk uploads over parallel for simpler implementation, with the infrastructure ready to add parallelism later. We chose WebSocket over SSE because sync requires bidirectional communication for conflict acknowledgment.

For future improvements, I'd add end-to-end encryption with per-file keys wrapped by user's master key, implement parallel chunk uploads with intelligent bandwidth management, and add optimistic UI updates with rollback for failed operations. The shared type system makes these enhancements safe to add incrementally."
