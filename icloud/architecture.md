# Design iCloud Sync - Architecture

## System Overview

iCloud is a file and data synchronization service across Apple devices. Core challenges involve consistency, conflict resolution, and efficient sync at scale.

**Learning Goals:**
- Build bidirectional sync protocols
- Design conflict resolution systems
- Implement chunk-based file transfer
- Handle offline-first architecture

---

## Requirements

### Functional Requirements

1. **Sync**: Bidirectional file synchronization across iPhone, iPad, Mac, and web
2. **Photos**: Photo library sync with derivative generation (thumbnail, preview, full-res)
3. **Conflict**: Detect and resolve concurrent edits using version vectors
4. **Offline**: Work offline with local queue, sync when connectivity returns
5. **Share**: Share files and photo albums with other users

### Non-Functional Requirements

- **Consistency**: Eventual consistency with causal ordering via version vectors
- **Latency**: < 5 seconds for sync propagation between online devices
- **Storage**: Petabytes of user data across billions of files
- **Privacy**: End-to-end encryption for sensitive categories
- **Availability**: 99.99% for sync operations
- **Durability**: 99.999999999% (11 nines) for stored data
- **Throughput**: 100K+ file operations per second globally

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                 │
│          iPhone │ iPad │ Mac │ Apple Watch │ Web                 │
│     Local file system + sync engine + offline queue             │
└─────────────────────────────────────────────────────────────────┘
                              │ HTTPS + WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CDN / Edge Network                            │
│       Photo derivatives, shared album assets, static files      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                   │
│         (Auth, Rate Limiting, Routing, Request Dedup)           │
└─────────────────────────────────────────────────────────────────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│   Sync     │ │  Storage   │ │   Photo    │ │   Share    │
│  Service   │ │  Service   │ │  Service   │ │  Service   │
│            │ │            │ │            │ │            │
│ Version    │ │ Chunk mgmt │ │ Derivatives│ │ Albums     │
│ vectors    │ │ Dedup      │ │ Thumbnails │ │ Permissions│
│ Conflict   │ │ Upload/DL  │ │ EXIF parse │ │ Public URL │
│ resolution │ │ Quota      │ │ Favorites  │ │            │
└─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
      │              │              │              │
      ▼              ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                  │
├─────────────────┬───────────────────┬───────────────────────────┤
│  PostgreSQL     │  Redis/Valkey     │  Object Storage (S3)      │
│  - File meta    │  - Sync state     │  - File chunks            │
│  - Versions     │  - Cache (meta)   │  - Photo derivatives      │
│  - Photos       │  - Idempotency    │  - Thumbnails             │
│  - Albums       │  - Rate limits    │                           │
│  - Sync ops     │  - WebSocket pub  │                           │
├─────────────────┤                   │                           │
│  WebSocket Hub  │                   │                           │
│  - Device push  │                   │                           │
│  - Change notify│                   │                           │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Sync Engine (Version Vectors)

The sync engine uses version vectors to detect causality and conflicts between devices editing the same file.

**Version Vector**: A map of `{deviceId: sequenceNumber}` attached to each file. When device A edits a file, it increments its own entry: `{A: 3, B: 2}`. When device B independently edits, it has `{A: 2, B: 3}`. These vectors diverge, signaling a conflict.

**Comparison Logic:**

Given vectors V1 and V2, iterate all device entries:
- If V1[d] > V2[d] for some devices AND V2[d] > V1[d] for others: **conflict** (concurrent edits)
- If V1[d] >= V2[d] for all devices: **V1 is newer** (V1 causally dominates)
- If V2[d] >= V1[d] for all devices: **V2 is newer**
- If equal: **same version**

**Conflict Resolution Strategy:**
1. **Auto-merge** if possible (e.g., both added different photos to an album)
2. **Last-write-wins** with user notification for binary conflicts
3. **Conflict copy** for irreconcilable edits: keep both versions, name the conflict copy `filename (conflict from DeviceName).ext`

**Sync Protocol (Push/Pull):**
1. Device connects and sends its sync cursor (last known server sequence number)
2. Server returns all changes since that cursor
3. Device applies remote changes, detects conflicts with local pending changes
4. Device pushes local changes with version vectors
5. Server validates version vectors, detects conflicts, stores new versions
6. Server broadcasts change notifications to all other connected devices via WebSocket

### 2. Chunk-Based File Storage

Files are split into content-addressed chunks for efficient storage and transfer.

**Chunking Strategy:**
- Fixed-size 4MB chunks (simple, predictable)
- Each chunk is SHA-256 hashed for content addressing
- Chunks are stored once globally with reference counting for deduplication
- Upload only chunks that don't already exist in the global chunk store

**Deduplication Flow:**
1. Client computes chunk hashes for a file
2. Client queries server: "which of these chunks do you already have?"
3. Server checks `chunk_store` table by hash
4. Client uploads only missing chunks
5. Server creates `file_chunks` records linking file to its chunks
6. Global `chunk_store.reference_count` is incremented

**Dedup savings** are significant: similar documents share most chunks (a 10MB file with a 1-line edit uploads only 4MB instead of 10MB). Across users, common files (OS updates, popular documents) are stored once.

**Delta Sync**: When a file is modified, only changed chunks are uploaded. The client computes the new chunk list and diffs against the old chunk list stored on the server.

### 3. Photo Service

Photos require special handling due to size (10-50MB per RAW) and the need for multiple derivatives.

**Derivative Pipeline:**
1. Original uploaded to object storage (full resolution)
2. Server generates three derivatives using Sharp:
   - Thumbnail: 200px wide, JPEG quality 80 (~10KB)
   - Preview: 1024px wide, JPEG quality 85 (~100KB)
   - Full resolution: original file
3. EXIF metadata extracted: camera make/model, GPS coordinates, capture time
4. All three derivatives stored in separate object storage buckets

**Optimized Storage Mode**: Devices track which photos have full-res locally (`device_photos` junction table). When device storage is low, full-res copies are evicted, keeping only thumbnails. Full-res is always in the cloud and downloaded on demand.

**Photo Organization**: Albums are user-created collections with a junction table (`album_photos`). Albums can be shared with other users via `album_shares` with optional contribute permissions. Shared albums generate a unique `share_token` for public URL access.

### 4. Real-Time Sync (WebSocket)

WebSocket connections provide instant change notification to online devices.

When a file operation completes on one device, the server broadcasts a lightweight change event to all other devices owned by the same user. The event contains the file ID and operation type -- not the file content. Receiving devices then pull the updated metadata and content as needed.

This avoids pushing large payloads over WebSocket while ensuring sub-second notification latency for online devices.

---

## Database Schema

### Entity-Relationship Overview

```
┌──────────────┐     1:N      ┌──────────────┐     1:N      ┌──────────────┐
│    users     │◄─────────────│   devices    │◄─────────────│device_photos │
│──────────────│              │──────────────│              │──────────────│
│ id (UUID PK) │              │ id (UUID PK) │              │ device_id FK │
│ email        │              │ user_id FK   │              │ photo_id FK  │
│ password_hash│              │ name         │              │ has_full_res │
│ storage_quota│              │ device_type  │              └──────────────┘
│ storage_used │              │ sync_cursor  │
│ role         │              └──────┬───────┘
└──────┬───────┘                     │
       │                             │ last_modified_by
       │ 1:N                         │
       ▼                             ▼
┌──────────────┐     1:N      ┌──────────────┐     1:N      ┌──────────────┐
│    files     │◄─────────────│ file_versions│              │ file_chunks  │
│──────────────│              │──────────────│              │──────────────│
│ id (UUID PK) │              │ id (UUID PK) │              │ id (UUID PK) │
│ user_id FK   │              │ file_id FK   │              │ file_id FK   │
│ parent_id FK │◄─── self-ref │ version_num  │              │ chunk_index  │
│ name, path   │              │ content_hash │              │ chunk_hash   │
│ version_vector│             │ version_vec  │              │ storage_key  │
│ is_folder    │              │ is_conflict  │              └──────────────┘
│ is_deleted   │              └──────────────┘
└──────┬───────┘                                            ┌──────────────┐
       │                                                    │ chunk_store  │
       │ 1:1                                                │──────────────│
       ▼                                                    │chunk_hash PK │
┌──────────────┐     N:M (albums)     ┌──────────────┐     │ storage_key  │
│   photos     │◄─────────────────────│album_photos  │     │ ref_count    │
│──────────────│                      │──────────────│     └──────────────┘
│ id (UUID PK) │                      │ album_id FK  │
│ user_id FK   │                      │ photo_id FK  │
│ file_id FK   │                      └──────────────┘
│ original_hash│                             ▲
│ thumb/prev/  │                             │
│ full_res keys│              ┌──────────────┤
│ EXIF metadata│              │   albums     │     1:N      ┌──────────────┐
│ is_favorite  │              │──────────────│◄─────────────│album_shares  │
└──────────────┘              │ id (UUID PK) │              │──────────────│
                              │ user_id FK   │              │ album_id FK  │
                              │ name         │              │ user_id FK   │
                              │ is_shared    │              │can_contribute│
                              │ share_token  │              └──────────────┘
                              └──────────────┘
```

### Table Definitions

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  storage_quota BIGINT DEFAULT 5368709120,  -- 5GB default
  storage_used BIGINT DEFAULT 0,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Devices
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  device_type VARCHAR(50) NOT NULL,
  last_sync_at TIMESTAMP,
  sync_cursor JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_devices_user ON devices(user_id);

-- Files (self-referencing for folder hierarchy)
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES files(id) ON DELETE CASCADE,
  name VARCHAR(500) NOT NULL,
  path VARCHAR(1000) NOT NULL,
  mime_type VARCHAR(200),
  size BIGINT DEFAULT 0,
  content_hash VARCHAR(64),
  version_vector JSONB DEFAULT '{}',
  is_folder BOOLEAN DEFAULT FALSE,
  is_deleted BOOLEAN DEFAULT FALSE,
  last_modified_by UUID REFERENCES devices(id),
  created_at TIMESTAMP DEFAULT NOW(),
  modified_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_files_user_path ON files(user_id, path);
CREATE INDEX idx_files_parent ON files(parent_id);
CREATE INDEX idx_files_user_deleted ON files(user_id, is_deleted);

-- File chunks (per-file chunk manifest)
CREATE TABLE file_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_hash VARCHAR(64) NOT NULL,
  chunk_size INTEGER NOT NULL,
  storage_key VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(file_id, chunk_index)
);

CREATE INDEX idx_chunks_file ON file_chunks(file_id);
CREATE INDEX idx_chunks_hash ON file_chunks(chunk_hash);

-- Global chunk deduplication store
CREATE TABLE chunk_store (
  chunk_hash VARCHAR(64) PRIMARY KEY,
  storage_key VARCHAR(200) NOT NULL,
  chunk_size INTEGER NOT NULL,
  reference_count INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW()
);

-- File version history (for conflict resolution)
CREATE TABLE file_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  version_vector JSONB NOT NULL,
  created_by UUID REFERENCES devices(id),
  is_conflict BOOLEAN DEFAULT FALSE,
  conflict_resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(file_id, version_number)
);

CREATE INDEX idx_versions_file ON file_versions(file_id);

-- Sync operations log
CREATE TABLE sync_operations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  operation_type VARCHAR(20) NOT NULL,
  operation_data JSONB,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE INDEX idx_sync_ops_user_device ON sync_operations(user_id, device_id);
CREATE INDEX idx_sync_ops_status ON sync_operations(status);

-- Photos
CREATE TABLE photos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  original_hash VARCHAR(64) NOT NULL,
  thumbnail_key VARCHAR(200),
  preview_key VARCHAR(200),
  full_res_key VARCHAR(200),
  width INTEGER,
  height INTEGER,
  taken_at TIMESTAMP,
  location_lat DECIMAL(10, 8),
  location_lng DECIMAL(11, 8),
  camera_make VARCHAR(100),
  camera_model VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  is_favorite BOOLEAN DEFAULT FALSE,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  modified_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_photos_user ON photos(user_id);
CREATE INDEX idx_photos_user_date ON photos(user_id, taken_at DESC);
CREATE INDEX idx_photos_favorite ON photos(user_id, is_favorite) WHERE is_favorite = TRUE;

-- Albums
CREATE TABLE albums (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  cover_photo_id UUID REFERENCES photos(id) ON DELETE SET NULL,
  is_shared BOOLEAN DEFAULT FALSE,
  share_token VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_albums_user ON albums(user_id);
CREATE UNIQUE INDEX idx_albums_share_token ON albums(share_token) WHERE share_token IS NOT NULL;

-- Album-photo junction
CREATE TABLE album_photos (
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  photo_id UUID REFERENCES photos(id) ON DELETE CASCADE,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (album_id, photo_id)
);

-- Album sharing
CREATE TABLE album_shares (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  shared_with_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  can_contribute BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(album_id, shared_with_user_id)
);

-- Device photo sync state
CREATE TABLE device_photos (
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  photo_id UUID REFERENCES photos(id) ON DELETE CASCADE,
  has_full_res BOOLEAN DEFAULT FALSE,
  last_viewed TIMESTAMP,
  downloaded_at TIMESTAMP,
  PRIMARY KEY (device_id, photo_id)
);

-- Sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);
```

### Schema Design Rationale

**Self-referencing files table**: `parent_id` references `files(id)` to form a tree hierarchy for folders. `path` stores the materialized path (e.g., `/Documents/Work/report.pdf`) for fast prefix queries (`WHERE path LIKE '/Documents/%'`). Both are maintained: `parent_id` for tree traversal, `path` for fast lookups.

**Version vectors as JSONB**: `{deviceId: sequenceNumber}` maps naturally to JSONB. PostgreSQL JSONB supports efficient containment queries and indexing if needed. The vector is small (one entry per device, typically 2-5 devices per user).

**chunk_store with reference counting**: Global deduplication table keyed by content hash. When multiple files share the same chunk, `reference_count` tracks how many references exist. Chunks with zero references are garbage-collected. This pattern saves 30-50% storage for typical document workloads.

**Three photo derivative keys**: `thumbnail_key`, `preview_key`, `full_res_key` are separate object storage paths. This allows CDN caching of immutable content-addressed derivatives with infinite TTL. Devices download only the derivative they need (thumbnail for grid view, preview for lightbox, full-res for editing).

**Partial index for favorites**: `WHERE is_favorite = TRUE` keeps the index tiny since only a small percentage of photos are favorited. The "Favorites" album query hits this small index instead of scanning all photos.

**device_photos junction table**: Tracks which devices have full-resolution copies of which photos. Enables "Optimize Mac Storage" -- when device storage is low, evict full-res copies (set `has_full_res = FALSE`), keeping only cloud-backed thumbnails.

**sync_operations log**: Append-only log of all sync operations for debugging, conflict analysis, and audit. `file_id` uses `SET NULL` on delete so the log preserves the operation record even after the file is removed.

---

## API Design

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Create user account |
| POST | `/api/v1/auth/login` | Authenticate, create session, register device |
| POST | `/api/v1/auth/logout` | Destroy session |
| GET | `/api/v1/files` | List files in a folder |
| POST | `/api/v1/files` | Create file or folder |
| PUT | `/api/v1/files/:id` | Update file metadata |
| DELETE | `/api/v1/files/:id` | Soft-delete file |
| POST | `/api/v1/files/:id/upload` | Upload file content (chunked) |
| GET | `/api/v1/files/:id/download` | Download file content |
| POST | `/api/v1/sync/push` | Push local changes to server (idempotent) |
| GET | `/api/v1/sync/pull` | Pull remote changes since cursor |
| GET | `/api/v1/sync/conflicts` | List unresolved conflicts |
| POST | `/api/v1/sync/conflicts/:id/resolve` | Resolve a conflict |
| GET | `/api/v1/photos` | List photos with pagination |
| POST | `/api/v1/photos/upload` | Upload photo (generates derivatives) |
| GET | `/api/v1/photos/:id/thumbnail` | Get thumbnail derivative |
| GET | `/api/v1/photos/:id/preview` | Get preview derivative |
| GET | `/api/v1/photos/:id/full` | Get full-resolution original |
| POST | `/api/v1/photos/:id/favorite` | Toggle favorite status |
| GET | `/api/v1/devices` | List user's devices |
| GET | `/api/v1/admin/stats` | Admin system statistics |
| GET | `/api/v1/admin/users` | Admin user management |
| GET | `/health` | Full system health check |
| GET | `/health/live` | Liveness probe |
| GET | `/health/ready` | Readiness probe |
| GET | `/metrics` | Prometheus metrics |
| WS | `/ws` | WebSocket for real-time sync notifications |

---

## Key Design Decisions

### 1. Version Vectors vs Timestamps

Version vectors detect true causality: two devices editing independently produce diverging vectors that cannot be ordered by wall-clock time alone. Timestamps fail because device clocks drift (by seconds to minutes), leading to silent data loss when a "newer" timestamp overwrites a concurrent edit. Version vectors guarantee that concurrent edits are detected as conflicts, never silently lost. The trade-off is increased metadata size (one entry per device) and more complex merge logic, but for a sync service where data integrity is paramount, this is essential.

### 2. Chunk-Based Storage vs Whole-File

Chunking files into 4MB content-addressed blocks enables three critical features: (1) deduplication across files and users (common documents stored once), (2) delta sync (only changed chunks uploaded on edit), and (3) resumable uploads (retry from the last successful chunk, not the beginning). The trade-off is increased complexity in the storage layer (chunk manifest tracking, reference counting, garbage collection) and small files being inefficient (a 10KB file still creates a chunk record). We mitigate the small-file overhead by storing files under 1MB inline without chunking.

### 3. Optimized Storage Mode for Photos

Rather than syncing all full-resolution photos to all devices (which would fill a 128GB iPhone in months), we sync only thumbnails by default and download full-res on demand. The `device_photos` table tracks what each device has locally. This reduces device storage by 95%+ while keeping the full library browsable. The trade-off is latency when opening a photo for the first time (must download from cloud), mitigated by predictive prefetching of recently viewed albums.

---

## Caching and Edge Strategy

### CDN Layer

Photo derivatives are the highest-bandwidth content. Thumbnails and previews are content-addressed (keyed by hash) and cached at CDN edge with `Cache-Control: public, max-age=31536000, immutable`. Since the content hash changes when the photo changes, no explicit cache invalidation is needed.

### Redis/Valkey Cache

| Data Type | TTL | Pattern | Invalidation |
|-----------|-----|---------|--------------|
| File metadata | 1 hour | Cache-aside | On file update/delete |
| User storage quota | 5 minutes | Cache-aside | On upload/delete |
| Sync state cursor | 24 hours | Write-through | On sync completion |
| Photo derivatives | Forever | CDN + content-hash | Never (immutable) |
| Chunk existence | 1 hour | Cache-aside | On chunk upload |
| Device list | 15 minutes | Cache-aside | On device register/remove |
| Idempotency keys | 24 hours | Write-on-submit | Natural expiry |

**Write-Through** is used for sync state because losing the cursor would cause the device to re-sync everything. Both cache and database are written atomically.

**Cache-Aside** is used for file metadata where occasional stale reads (up to TTL) are acceptable. On writes, relevant cache keys are explicitly invalidated.

---

## Consistency and Idempotency

### Write Consistency Model

| Data Type | Consistency | Rationale |
|-----------|-------------|-----------|
| File metadata | Strong (transactions) | Must not lose edits |
| Version vectors | Strong (compare-and-swap) | Conflict detection requires accuracy |
| Chunk storage | Eventual (content-addressed) | Chunks are immutable; dedup is idempotent |
| Photo derivatives | Eventual | Regenerated if missing |
| Sync operations log | Strong (append-only) | Audit trail must be complete |
| User storage quota | Eventually consistent | Updated after upload/delete, minor lag acceptable |

### Idempotency Implementation

**Sync Push**: The client sends an `Idempotency-Key` header derived from `SHA-256(userId + operation + changes_hash)`. The server checks Redis for an existing result:
- **Found**: Return cached response (safe replay)
- **Not found**: Acquire a processing lock (5-min TTL), execute the handler, store the result (24h TTL), release the lock
- **In progress**: Wait up to 30 seconds for the result, or return 409 Conflict with `Retry-After`

This handles the common case where a client times out after 30 seconds, the server actually processed the request, and the client retries -- without the retry causing duplicate files or incorrect version vectors.

**File Upload**: Content-addressed chunks are inherently idempotent. Uploading the same chunk (same hash) twice is a no-op since the chunk store uses the hash as the primary key.

---

## Observability

### Metrics (Prometheus)

| Category | Metric | Type | Purpose |
|----------|--------|------|---------|
| HTTP | `icloud_http_request_duration_seconds` | Histogram | API latency by endpoint |
| Sync | `icloud_sync_duration_seconds` | Histogram | Sync operation timing |
| Sync | `icloud_conflicts_total` | Counter | Conflict frequency |
| Storage | `icloud_chunk_operation_duration_seconds` | Histogram | MinIO/S3 latency |
| Storage | `icloud_dedup_hits_total` | Counter | Deduplication effectiveness |
| Cache | `icloud_cache_hits_total` | Counter | Cache hit rate |
| Circuit | `icloud_circuit_breaker_state` | Gauge | Breaker open/closed status |
| WebSocket | `icloud_websocket_connections` | Gauge | Active real-time connections |

### Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Sync p95 latency | > 5s | > 10s |
| Sync error rate | > 1% | > 5% |
| Conflict rate spike | > 10/min | > 50/min |
| Cache hit rate | < 85% | < 70% |
| Storage quota > 95% | per-user | per-user |
| Circuit breaker open | any breaker | storage breaker |

### Structured Logging

Pino JSON logger with:
- Request correlation IDs for tracing sync operations across services
- Component child loggers (`syncService`, `chunkService`, `photoService`)
- Audit logger for security events (file shares, device registrations, admin actions)
- Development mode: `pino-pretty` for human-readable output
- Production mode: raw JSON for log aggregators (ELK, Loki)

---

## Failure Handling

### Circuit Breaker for Storage

MinIO/S3 failures can cascade to the entire sync service. Three separate circuit breakers protect different operation types:

| Breaker | Timeout | Threshold | Reset | Purpose |
|---------|---------|-----------|-------|---------|
| `storage_put` | 30s | 50% error | 30s | Large uploads |
| `storage_get` | 15s | 50% error | 30s | Downloads |
| `storage_stat` | 5s | 50% error | 15s | Existence checks |

State machine: CLOSED --(threshold reached)--> OPEN --(reset timeout)--> HALF-OPEN --(3 successes)--> CLOSED.

When a breaker opens, the sync service returns 503 for storage-dependent operations. File metadata operations (list, rename, delete) continue working since they only touch PostgreSQL.

### Retry Strategy

**Client-side**: Exponential backoff (1s base, 2x multiplier, 30s max) with jitter. Idempotency key ensures safe replay. Only 5xx errors are retried; 4xx errors (validation, auth) are not.

**Server-side**: Sync push operations that partially fail (some chunks uploaded, metadata not committed) are rolled back within a database transaction. The client can retry the entire operation safely via idempotency key.

### Graceful Shutdown

On SIGTERM/SIGINT: close WebSocket connections with close frame, drain in-flight HTTP requests, close database pool and Redis connections, close MinIO client, exit.

---

## Scalability Considerations

### What Breaks First

1. **Object storage throughput** -- At scale, chunk uploads/downloads dominate bandwidth. Solution: CDN for reads, multi-region S3 with cross-region replication.
2. **Sync state database** -- Every file operation writes to `files`, `file_versions`, and `sync_operations`. Solution: user-level sharding (all data for a user on the same shard), read replicas for listing queries.
3. **WebSocket connections** -- Each online device maintains a persistent connection. At 1B devices, this requires a distributed WebSocket hub (e.g., Redis pub/sub for cross-instance fan-out).
4. **Photo derivative generation** -- CPU-intensive Sharp operations. Solution: dedicated worker pool with auto-scaling based on queue depth.

### Horizontal Scaling Path

- **Sync service**: Stateless, horizontal scaling behind load balancer. WebSocket connections are sticky by user_id.
- **Storage service**: Stateless, scales with S3/MinIO throughput. Chunk existence checks cached in Redis.
- **Database**: User-level sharding. All tables for a user co-located on the same shard for transactional integrity.
- **Photo workers**: Queue-based with auto-scaling. Derivative generation is embarrassingly parallel.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Sync model | Version vectors | Timestamps / CRDTs | Correct conflict detection without clock sync; CRDTs too complex for file sync |
| Storage | Chunked, content-addressed | Whole file | 30-50% dedup savings, delta sync, resumable uploads |
| Photo delivery | Optimized (thumbnail-first) | Full sync | 95% device storage savings |
| Encryption | Per-file keys | Single user key | Granular sharing, independent key rotation |
| Real-time sync | WebSocket | Polling / SSE | Bidirectional, sub-second latency, connection state tracking |
| Chunk size | 4MB fixed | Content-defined (Rabin) | Simpler implementation; content-defined better for dedup at scale |
| Conflict resolution | Version vectors + conflict copies | Last-write-wins | No silent data loss; user decides for irreconcilable conflicts |
| Session storage | Cookie + token in DB | JWT | Immediate revocation, server-side session data |

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + Express + React.

### Local Architecture

```
┌─────────────────────────────────────────────────────────────┐
│               React Frontend (:5173)                         │
│  FileBrowser + PhotoGallery + AdminDashboard                │
│  Drag-and-drop upload, photo viewer, conflict resolution    │
│  Virtualized photo grid (@tanstack/react-virtual)           │
│  State: Zustand (fileStore, photoStore, authStore)           │
└────────────────────────┬──────────────┬─────────────────────┘
                         │ HTTP         │ WebSocket (:3000/ws)
                         ▼              ▼
┌─────────────────────────────────────────────────────────────┐
│           Express Backend (:3000)                            │
│  Routes: auth, files, sync, photos, devices, admin          │
│  Middleware: auth (cookie+token), rate limiting, idempotency │
│  Services: websocket, chunks, sync                          │
│  Shared: logger, metrics, cache, circuitBreaker,            │
│          idempotency, health                                 │
└──────┬──────────────┬──────────────┬────────────────────────┘
       │              │              │
       ▼              ▼              ▼
┌────────────┐ ┌────────────┐ ┌────────────┐
│ PostgreSQL │ │   Valkey   │ │   MinIO    │
│  (:5432)   │ │  (:6379)   │ │(:9000/9001)│
│ DB:        │ │  Cache,    │ │ Buckets:   │
│ icloud_sync│ │  idempot., │ │ chunks,    │
│ User:icloud│ │  rate limit│ │ photos,    │
│            │ │            │ │ thumbnails │
└────────────┘ └────────────┘ └────────────┘
```

### Production Patterns Actually Implemented

| Pattern | File | Why It Matters at Scale |
|---------|------|------------------------|
| Structured logging (Pino) | `backend/src/shared/logger.ts` | JSON logs with correlation IDs; audit logger for compliance events (file shares, admin actions) |
| Prometheus metrics | `backend/src/shared/metrics.ts` | HTTP latency histograms, sync duration, conflict counters, chunk operation timing, WebSocket gauge, dedup hits |
| Redis caching (dual pattern) | `backend/src/shared/cache.ts` | Cache-aside for file metadata (1h TTL), write-through for sync state (24h TTL); explicit invalidation on writes |
| Circuit breakers (Opossum) | `backend/src/shared/circuitBreaker.ts` | Separate breakers for storage put (30s), get (15s), stat (5s); prevents MinIO failures from cascading |
| Idempotency | `backend/src/shared/idempotency.ts` | Redis lock + result cache for sync push operations; prevents duplicate files on client retry |
| Health checks | `backend/src/shared/health.ts` | Three tiers: `/health/live` (liveness), `/health/ready` (DB+Redis+MinIO), `/health` (full with breaker states) |
| Version vector sync | `backend/src/services/sync.ts` | Compare-and-detect conflicts, auto-merge or conflict copies, cursor-based pull |
| Chunk dedup | `backend/src/services/chunks.ts` | SHA-256 content addressing, reference counting, upload-only-missing optimization |
| WebSocket real-time | `backend/src/services/websocket.ts` | Per-user device broadcast on file operations; excludes originating device |
| Photo derivatives (Sharp) | `backend/src/routes/photos.ts` | Thumbnail (200px) + preview (1024px) + full-res; stored in separate MinIO buckets |
| Graceful shutdown | `backend/src/index.ts` | SIGTERM/SIGINT: close WebSocket, drain connections, close pools |
| Photo grid virtualization | `frontend/src/components/photos/PhotoGrid.tsx` | @tanstack/react-virtual row-based virtualization; constant 60fps with 1000+ photos |
| Rate limiting | `backend/src/index.ts` | 1000 requests per 15-minute window per IP |

### Frontend Component Architecture

The frontend is organized into feature modules with barrel exports:

| Module | Components | Purpose |
|--------|-----------|---------|
| `files/` | FileList, FileItem, FileToolbar, FileStatusBanners, DragOverlay, NewFolderModal, SelectionBar | iCloud Drive file browser with drag-and-drop |
| `photos/` | PhotoGrid, PhotoItem, PhotoViewer, PhotoToolbar, CreateAlbumModal | Photo library with virtualized grid and lightbox |
| `admin/` | OverviewTab, UsersTab, OperationsTab, ConflictsTab | Admin dashboard with system stats |
| `common/` | StatCard, LoadingSpinner, Modal | Shared UI primitives |

State management uses Zustand stores (`fileStore`, `photoStore`, `authStore`) for global state and React local state for UI concerns (modals, selections).

### Simplifications from Production Design

| Production | Local Substitute | Why |
|------------|-----------------|-----|
| S3 with cross-region replication | MinIO (single instance) | S3-compatible API, same code path |
| CDN for photo derivatives | Direct MinIO access via backend proxy | No edge network needed locally |
| Distributed WebSocket hub (Redis pub/sub) | In-process WebSocket with per-instance user map | Single server instance, no cross-instance fan-out needed |
| Content-defined chunking (Rabin fingerprint) | Fixed 4MB chunks | Simpler; Rabin better for dedup at scale |
| End-to-end encryption (per-file keys) | No encryption | Encryption layer orthogonal to sync protocol |
| Selective sync (per-folder, per-device) | Full sync to all devices | Feature complexity deferred |
| Background photo derivative pipeline | Synchronous Sharp processing in upload handler | No worker queue needed at dev scale |
| OAuth / Apple ID | Cookie + token session auth | Simpler; focused on sync, not identity |
| Offline queue with IndexedDB | Online-only (no local persistence) | Offline sync requires service worker |
| Read replicas for listing queries | Single PostgreSQL instance | One database sufficient for dev workload |

### What Was Omitted

- **CDN and edge caching** -- no multi-POP deployment
- **Multi-region deployment** -- single local instance
- **Kubernetes orchestration** -- Docker Compose only
- **End-to-end encryption** -- no per-file key management
- **Offline-first with IndexedDB** -- online-only
- **Selective sync** -- all files sync to all devices
- **User-level database sharding** -- single PostgreSQL
- **Content-defined chunking** -- fixed 4MB chunks
- **Compression before upload** -- gzip/zstd deferred
- **Public sharing links** -- share_token column exists but UI not implemented
