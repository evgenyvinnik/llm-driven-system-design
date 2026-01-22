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
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (React)                             │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ File Browser │  │ Photo Gallery│  │ Admin Panel            │ │
│  └──────────────┘  └──────────────┘  └────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  Zustand Stores                           │   │
│  │  File Store  │  Photo Store  │  Sync State Store          │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │       Sync Engine + Offline Queue + IndexedDB            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ REST + WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Backend (Node.js)                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    API Gateway                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│       │                    │                    │                │
│       ▼                    ▼                    ▼                │
│  ┌────────────┐    ┌──────────────┐    ┌──────────────────┐     │
│  │Sync Service│    │Photo Service │    │  WebSocket Hub   │     │
│  └────────────┘    └──────────────┘    └──────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                       Data Layer                                 │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────────────┐    │
│  │ PostgreSQL │  │   MinIO    │  │        Valkey           │    │
│  │ - Metadata │  │ - Chunks   │  │ - Sessions              │    │
│  │ - Versions │  │ - Photos   │  │ - Sync cursors          │    │
│  └────────────┘  └────────────┘  └─────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Shared Type System (8 minutes)

A single source of truth for types ensures frontend and backend stay synchronized.

### Shared Types Definition

Core types shared between frontend and backend via `@shared/types`:

**Version Vector** (`VersionVector`):
- Maps `deviceId` to `sequenceNumber` for conflict detection
- Enables causal ordering of changes across devices

**Sync Status** (`SyncStatus`):
- Values: `'synced' | 'pending' | 'syncing' | 'conflict' | 'error'`
- Tracks file state in UI and during operations

**File Item** (`FileItem`):
- Core fields: `id`, `name`, `path`, `type` (file/folder), `size`
- Sync fields: `contentHash`, `version` (VersionVector), `isDeleted`
- Timestamps: `createdAt`, `modifiedAt`

**Client File Item** (`ClientFileItem` extends `FileItem`):
- Adds: `syncStatus`, `localModifiedAt`, `pendingOperationId`
- Frontend-only state for optimistic UI

**Sync Push Request/Response**:
- Request: `deviceId`, `lastSyncToken`, `changes[]`
- Response: `syncToken`, `applied[]`, `conflicts[]`, `errors[]`

**Conflict Info**:
- `fileId`, `fileName`
- `localVersion` vs `serverVersion` (both VersionVector)
- `localModifiedBy` vs `serverModifiedBy`

**Photo Types**:
- Derivatives: `thumbnail` (200px), `preview` (1024px), `display` (2048px)
- Metadata: `takenAt`, `location`, `width`, `height`

**Chunk Upload Types**:
- `ChunkManifest`: `fileId`, `totalSize`, `chunkSize`, `chunks[]`
- `ChunkInfo`: `index`, `hash`, `size`, `uploaded`

### Frontend Store Using Shared Types

The `useFileStore` Zustand store:
- Manages `Map<string, ClientFileItem>` for files
- Tracks `pendingChanges[]` and `conflicts[]`
- `lastSyncToken` for incremental sync
- `deviceId` for version vector updates

**Push Changes Flow**:
1. Mark files as `syncing` status
2. POST to `/api/v1/sync/push` with `SyncPushRequest`
3. On response: mark applied as `synced`, errors as `error`
4. Add any conflicts to conflict list
5. Update `lastSyncToken` for next sync

### Backend Sync Service

**`processPush()` method**:
1. Loop through changes in transaction
2. For each change, call `applyChange()`
3. If conflict detected, add to conflicts array
4. Generate new sync token
5. Notify other devices via WebSocket

**Version Vector Comparison**:

```
┌────────────────────────────────────────────────────────┐
│              compareVersions(client, server)           │
├────────────────────────────────────────────────────────┤
│  For each device in allDevices:                        │
│    clientSeq = clientVersion[device] || 0              │
│    serverSeq = serverVersion[device] || 0              │
│    if clientSeq > serverSeq: clientNewer = true        │
│    if serverSeq > clientSeq: serverNewer = true        │
├────────────────────────────────────────────────────────┤
│  Results:                                              │
│    both newer ──▶ 'conflict'                           │
│    only client ──▶ 'client-newer'                      │
│    only server ──▶ 'server-newer'                      │
│    neither ──▶ 'equal'                                 │
└────────────────────────────────────────────────────────┘
```

## Deep Dive: Chunked Upload Flow (10 minutes)

The chunked upload demonstrates tight frontend-backend integration.

### Backend Chunk Upload Endpoints

**POST `/files/:fileId/upload/init`**:
- Creates upload session in Redis (1 hour TTL)
- Stores: `fileId`, `userId`, `fileName`, `totalSize`, `chunkSize`, `totalChunks`
- Returns: `uploadId`, `chunkSize`, `totalChunks`

**PUT `/files/:fileId/upload/:uploadId/chunk/:index`**:
- Computes SHA-256 hash of chunk data
- Checks `chunk_store` for existing hash (deduplication)
- If new: upload to MinIO, insert with `reference_count = 1`
- If exists: increment `reference_count`
- Track chunk in Redis session
- Return progress percentage

**POST `/files/:fileId/upload/:uploadId/complete`**:
- Verify all chunks uploaded
- Sort chunks by index
- Compute file hash from chunk hashes
- Create/update file record with version vector increment
- Create file_chunks references
- Clean up Redis session
- Notify other devices via WebSocket

### Chunk Deduplication Flow

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Chunk     │    │  Existing?  │    │   MinIO     │
│   Data      │──▶ │  hash check │──▶ │   Storage   │
└─────────────┘    └─────────────┘    └─────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ New: ref_count = 1  │
              │ Exists: ref_count++ │
              └─────────────────────┘
```

### Frontend Chunked Uploader

**ChunkedUploader class**:
- Constant: `CHUNK_SIZE = 4MB`
- Tracks `uploadId` and `onProgress` callback

**uploadFile() method**:
1. Generate `fileId` UUID
2. Calculate `totalChunks`
3. POST to init endpoint
4. Loop through chunks with retry
5. POST to complete endpoint

**uploadChunkWithRetry()**:
- Max 3 retries with exponential backoff
- PUT chunk data as `application/octet-stream`
- Return chunk info on success

**resumeUpload()**:
- GET upload session status
- Find missing chunk indices
- Upload only missing chunks
- Complete upload

### Upload Progress Component

Visual representation:
- Fixed bottom-right panel
- Shows file name, progress bar, percentage
- Pause/Resume/Cancel buttons per upload
- Color: blue for uploading, red for error
- Status text: percentage or "Failed - click to retry"

## Deep Dive: WebSocket Real-Time Sync (8 minutes)

### Backend WebSocket Hub

**WebSocketHub class**:
- `clients`: Map<userId, Set<ConnectedClient>>
- Each client has: `socket`, `userId`, `deviceId`

**Connection Flow**:
1. Authenticate connection from request
2. Create `ConnectedClient` object
3. Add to user's client set
4. Send initial `sync_complete` event
5. Handle `close` and `error` events

**Broadcast Method**:
- Get user's client set
- Create full event with timestamp and sourceDeviceId
- Send to all clients except source device

**Event Types**:
- `file_changed`: File created/updated/deleted
- `file_deleted`: File removed
- `conflict_detected`: Version vector conflict
- `sync_complete`: Connection established

### Frontend WebSocket Client

**WebSocketClient class**:
- Manages single socket connection
- Reconnect with exponential backoff (max 5 attempts, up to 30s delay)
- Event listeners via `on(eventType, callback)`

**Connection Flow**:
```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   connect    │──▶ │  WebSocket   │──▶ │   onopen     │
│  (deviceId)  │    │   created    │    │ reset retry  │
└──────────────┘    └──────────────┘    └──────────────┘
       │                                       │
       │                                       ▼
       │                              ┌──────────────┐
       │                              │  onmessage   │
       │                              │ handleEvent  │
       │                              └──────────────┘
       │                                       │
       ▼                                       ▼
┌──────────────┐                      ┌──────────────┐
│   onclose    │                      │  listeners   │
│ reconnect    │                      │  callback()  │
└──────────────┘                      └──────────────┘
```

### Integrating WebSocket with Store

On store creation, register WebSocket listeners:

**`file_changed` handler**:
- Extract `fileId`, `action`, `file` from payload
- If deleted: remove from files Map
- If created/updated: set file with `synced` status

**`conflict_detected` handler**:
- Add conflict to conflicts array
- UI shows conflict resolution modal

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

### Sync Operations

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/sync/push` | POST | Submit local changes |
| `/api/v1/sync/pull` | GET | Get remote changes since token |

### File Operations

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/files/:fileId/upload/init` | POST | Initialize chunked upload |
| `/files/:fileId/upload/:uploadId/chunk/:index` | PUT | Upload single chunk |
| `/files/:fileId/upload/:uploadId/complete` | POST | Finalize upload |
| `/files/:fileId/download` | GET | Download file (reassembled) |

### Conflict Resolution

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/conflicts` | GET | List pending conflicts |
| `/api/v1/conflicts/:id/resolve` | POST | Resolve with: local/server/both |

### Photos

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/photos` | GET | Paginated photo list with cursor |
| `/api/v1/photos/upload` | POST | Upload photo (FormData) |

## Closing Summary (1 minute)

"The iCloud full-stack architecture is built around three core integration points:

1. **Shared type system** with `@shared/types` - ensuring frontend and backend stay synchronized with the same interfaces for sync state, conflicts, and file operations
2. **Chunked upload with resume capability** - tight frontend-backend coordination with upload sessions tracked in Redis and progress updates flowing back to the UI
3. **WebSocket real-time sync** - bidirectional communication that notifies all devices of changes and enables immediate conflict detection

The key trade-off throughout is simplicity vs. optimization. We chose sequential chunk uploads over parallel for simpler implementation, with the infrastructure ready to add parallelism later. We chose WebSocket over SSE because sync requires bidirectional communication for conflict acknowledgment.

For future improvements, I'd add end-to-end encryption with per-file keys wrapped by user's master key, implement parallel chunk uploads with intelligent bandwidth management, and add optimistic UI updates with rollback for failed operations. The shared type system makes these enhancements safe to add incrementally."
