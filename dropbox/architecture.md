# Dropbox - Cloud Storage - Architecture Design

## System Overview

A cloud file storage and synchronization service enabling users to upload, download, sync, share, and version files across multiple devices. The system handles petabyte-scale storage with content-addressed deduplication, chunked transfers for reliability, and real-time sync notifications.

## Requirements

### Functional Requirements

- **File upload/download**: Support files up to 10GB with chunked, resumable transfers
- **Sync across devices**: Real-time sync notifications via WebSocket, conflict detection
- **File sharing**: Public share links (password-protected, expiration, download limits), folder sharing with specific users
- **Version history**: Track file versions, restore previous versions, configurable retention
- **Folder hierarchy**: Create, rename, move, delete folders; nested structure with materialized paths
- **Deduplication**: Content-addressed chunk storage eliminates duplicate data
- **Admin dashboard**: System-wide statistics, user management, storage monitoring

### Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Availability | 99.99% (52 min downtime/year) | Users depend on file access for work; downtime causes productivity loss |
| Upload latency | < 100ms per chunk acknowledgment | Users perceive upload as responsive |
| Download latency | < 50ms time-to-first-byte (metadata) | File browser feels instant |
| Sync latency | < 2s for change propagation | Near real-time sync across devices |
| Consistency | Strong for metadata, eventual for sync notifications | Users expect their file view to be current |
| Durability | 99.999999999% (11 nines) | Data loss is unacceptable for a storage service |
| Throughput | 100,000 concurrent uploads | Handle peak business hours |

## Capacity Estimation

### Production Scale

| Metric | Value | Calculation |
|--------|-------|-------------|
| Registered users | 500M | |
| Daily Active Users | 100M | 20% DAU ratio |
| Files per user | 1,000 average | |
| Total files | 500B | |
| Average file size | 1 MB | Mix of documents, images, videos |
| Total logical storage | 500 PB | Before deduplication |
| Deduplication ratio | ~40% | Shared files, versioning |
| Actual storage | ~300 PB | After dedup |
| Daily uploads | 1B files | ~12,000 RPS average |
| Daily downloads | 5B files | ~58,000 RPS average |
| Chunk size | 4 MB | Balance between upload granularity and overhead |
| Chunks per file (avg) | 1 (most files < 4MB) | Large files split into multiple chunks |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Concurrent users | 5-10 |
| Files uploaded/day | 500 |
| Daily storage growth | 2.5 GB |
| Storage after 30 days | ~50 GB (with ~30% dedup) |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                CLIENTS                                       │
│           Web Browser / Desktop Client / Mobile App                          │
└──────────────┬───────────────────────────────┬───────────────────────────────┘
               │ HTTPS                         │ WebSocket
               ▼                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        API Gateway / Load Balancer                           │
│                (nginx / ALB — TLS, rate limiting, routing)                   │
└────────┬─────────────────┬──────────────────────────────┬────────────────────┘
         │                 │                              │
         ▼                 ▼                              ▼
┌─────────────────┐ ┌─────────────────┐          ┌─────────────────┐
│  API Server 1   │ │  API Server 2   │          │  API Server N   │
│  (Express.js)   │ │  (Express.js)   │   ...    │  (Express.js)   │
│  REST + WS      │ │  REST + WS      │          │  REST + WS      │
└────────┬────────┘ └────────┬────────┘          └────────┬────────┘
         │                   │                            │
         └───────────────────┼────────────────────────────┘
                             │
    ┌────────────────────────┼─────────────────────────────┐
    │                        │                             │
    ▼                        ▼                             ▼
┌─────────────────┐ ┌─────────────────┐           ┌─────────────────┐
│  PostgreSQL     │ │  Redis Cluster  │           │    RabbitMQ     │
│  (Metadata)     │ │  (Sessions,     │           │  (Sync Events,  │
│  Primary +      │ │   Cache,        │           │   Background    │
│  Read Replicas  │ │   Pub/Sub)      │           │   Jobs)         │
└─────────────────┘ └─────────────────┘           └────────┬────────┘
                                                           │
    ┌──────────────────────────────────────────────────────┼────────┐
    │                                                      │        │
    ▼                                                      ▼        ▼
┌─────────────────────────────────┐               ┌─────────────────────┐
│         S3 / Object Storage     │               │    Sync Workers     │
│  (Chunk Store — content-addressed)│              │  (WebSocket fanout, │
│  Multi-region replication        │               │   garbage collection)│
└─────────────────────────────────┘               └─────────────────────┘
```

### Core Components

| Component | Responsibility | Technology |
|-----------|----------------|------------|
| API Server | HTTP API, WebSocket sync, authentication, chunked upload orchestration | Express + TypeScript |
| Metadata Store | Files, folders, users, shares, versions, upload sessions | PostgreSQL |
| Chunk Store | Binary file chunks, content-addressed by SHA-256 hash | S3 (MinIO locally) |
| Session/Cache | User sessions, folder listing cache, pub/sub for sync | Redis Cluster |
| Message Queue | Sync notifications, garbage collection, background jobs | RabbitMQ |
| Sync Workers | Fan out sync events to WebSocket clients, cleanup jobs | Node.js workers |
| Load Balancer | Request distribution, health checks, TLS termination | nginx / ALB |

## Request Flows

### File Upload Flow (Chunked, Resumable, Deduplicated)

```
1. Client: POST /api/v1/upload/init
   Body: { filename, size, parentFolderId, mimeType }
   Response: { uploadId, chunkSize: 4MB, totalChunks }

2. Client: Compute SHA-256 hash for each chunk locally

3. Client: POST /api/v1/upload/{uploadId}/check
   Body: { chunkHashes: ["abc123...", "def456...", ...] }
   Response: { needed: [0, 2, 5], existing: [1, 3, 4] }
   → Server checks chunks table; existing chunks skip upload (deduplication)

4. For each needed chunk:
   Client: PUT /api/v1/upload/{uploadId}/chunk/{index}
   Body: <binary chunk data>
   Server:
     - Verify chunk hash matches
     - Store in object storage: chunks/{sha256-hash}
     - Insert/increment reference_count in chunks table
     - Update upload session received_chunks

5. Client: POST /api/v1/upload/{uploadId}/complete
   Server:
     - Create/update file record in PostgreSQL
     - Create file_version record linking to chunks
     - Update user storage quota
     - Publish sync event via Redis pub/sub
     - Invalidate parent folder cache
   Response: { fileId, version: 1 }
```

### File Download Flow

```
1. Client: GET /api/v1/files/{fileId}
   Response: { id, name, size, version, chunks: [...], downloadUrl }

2. Client: GET /api/v1/files/{fileId}/download
   Server:
     - Verify ownership/share permissions
     - Stream chunks from object storage in order
     - Support byte-range requests for resume
   Response: Binary stream with Content-Disposition header
```

### Sync Notification Flow

```
1. Client connects: WS /ws?token={sessionToken}
   Server: Validate session, register client for user's sync channel

2. On file change (upload/delete/rename/move):
   API Server: Publish to Redis pub/sub channel sync:{userId}

3. All API servers subscribed to sync:* receive the message
   Forward to connected WebSocket clients for that user

4. Client receives: { type: "file_changed", fileId, action: "created" }
   Client: Refresh affected folder listing
```

## Database Schema

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    quota_bytes BIGINT DEFAULT 2147483648,  -- 2GB free tier
    used_bytes BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Files and Folders (unified table with is_folder flag)
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES files(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    is_folder BOOLEAN NOT NULL DEFAULT FALSE,
    size BIGINT DEFAULT 0,
    mime_type VARCHAR(255),
    content_hash VARCHAR(64),  -- SHA-256 of all chunk hashes combined
    version INTEGER DEFAULT 1,
    sync_status VARCHAR(20) DEFAULT 'synced'
        CHECK (sync_status IN ('synced', 'syncing', 'pending', 'error')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,  -- Soft delete for trash/restore

    UNIQUE(user_id, parent_id, name) WHERE deleted_at IS NULL
);
CREATE INDEX idx_files_user_parent ON files(user_id, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_user_id ON files(user_id) WHERE deleted_at IS NULL;

-- File chunks (per-file chunk references)
CREATE TABLE file_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_hash VARCHAR(64) NOT NULL,
    chunk_size INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(file_id, chunk_index)
);
CREATE INDEX idx_file_chunks_file_id ON file_chunks(file_id);
CREATE INDEX idx_file_chunks_hash ON file_chunks(chunk_hash);

-- Global chunk store (content-addressed, shared via deduplication)
CREATE TABLE chunks (
    hash VARCHAR(64) PRIMARY KEY,  -- SHA-256 hex
    size INTEGER NOT NULL,
    storage_key TEXT NOT NULL,  -- Object storage key
    reference_count INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- File versions (history)
CREATE TABLE file_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    size BIGINT NOT NULL,
    content_hash VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id),

    UNIQUE(file_id, version)
);
CREATE INDEX idx_file_versions_file_id ON file_versions(file_id);

-- File version chunks
CREATE TABLE file_version_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id UUID NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_hash VARCHAR(64) NOT NULL,
    chunk_size INTEGER NOT NULL,

    UNIQUE(version_id, chunk_index)
);

-- Shared links (public sharing)
CREATE TABLE shared_links (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id),
    url_token VARCHAR(32) UNIQUE NOT NULL,
    password_hash VARCHAR(255),  -- NULL = no password required
    expires_at TIMESTAMPTZ,
    download_count INTEGER DEFAULT 0,
    max_downloads INTEGER,
    access_level VARCHAR(20) DEFAULT 'view'
        CHECK (access_level IN ('view', 'download', 'edit')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_shared_links_token ON shared_links(url_token);
CREATE INDEX idx_shared_links_file_id ON shared_links(file_id);

-- Folder sharing (with specific users)
CREATE TABLE folder_shares (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    folder_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    shared_with UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_level VARCHAR(20) NOT NULL
        CHECK (access_level IN ('view', 'edit', 'owner')),
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(folder_id, shared_with)
);
CREATE INDEX idx_folder_shares_folder_id ON folder_shares(folder_id);
CREATE INDEX idx_folder_shares_shared_with ON folder_shares(shared_with);

-- Sessions table
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);

-- Upload sessions (resumable uploads)
CREATE TABLE upload_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id UUID REFERENCES files(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    parent_id UUID REFERENCES files(id),
    total_chunks INTEGER NOT NULL,
    uploaded_chunks INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'uploading', 'completed', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);
CREATE INDEX idx_upload_sessions_user_id ON upload_sessions(user_id);
```

### Object Storage Structure

```
dropbox-chunks/
  chunks/
    {sha256-hash}          # Raw chunk data, content-addressed
                           # Same hash = same data = stored once

dropbox-temp/
  uploads/
    {upload-session-id}/
      {chunk-index}        # Temporary storage during upload
```

### Redis Key Patterns

```
sess:{sessionId}                    → User session data (TTL: 24h)
cache:folder:{folderId}:listing     → Folder contents JSON (TTL: 5m)
cache:folder:root:{userId}:listing  → Root folder listing (TTL: 5m)
cache:file:{fileId}                 → File metadata JSON (TTL: 10m)
ratelimit:{userId}:upload           → Upload rate counter (TTL: 1m)
ratelimit:{ip}:api                  → API rate counter (TTL: 1m)
upload:active:{uploadId}            → Upload session status (TTL: 25h)
```

## API Design

### Core Endpoints

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| **Authentication** ||||
| POST | `/api/v1/auth/register` | Create account | Public |
| POST | `/api/v1/auth/login` | Login, create session | Public |
| POST | `/api/v1/auth/logout` | Destroy session | User |
| GET | `/api/v1/auth/me` | Current user info | User |
| **Files** ||||
| GET | `/api/v1/files` | List files in folder | User |
| GET | `/api/v1/files/{id}` | Get file metadata | User |
| GET | `/api/v1/files/{id}/download` | Download file (streamed) | User |
| DELETE | `/api/v1/files/{id}` | Soft delete file | User |
| POST | `/api/v1/files/{id}/restore` | Restore from trash | User |
| **Upload (Chunked)** ||||
| POST | `/api/v1/upload/init` | Start upload session | User |
| POST | `/api/v1/upload/{id}/check` | Check existing chunks (dedup) | User |
| PUT | `/api/v1/upload/{id}/chunk/{index}` | Upload single chunk | User |
| POST | `/api/v1/upload/{id}/complete` | Finalize upload | User |
| DELETE | `/api/v1/upload/{id}` | Cancel upload | User |
| **Folders** ||||
| GET | `/api/v1/folders` | List root folders | User |
| GET | `/api/v1/folders/{id}` | Get folder contents | User |
| POST | `/api/v1/folders` | Create folder | User |
| PATCH | `/api/v1/folders/{id}` | Rename/move folder | User |
| DELETE | `/api/v1/folders/{id}` | Soft delete folder | User |
| **Versions** ||||
| GET | `/api/v1/files/{id}/versions` | List file versions | User |
| GET | `/api/v1/files/{id}/versions/{v}` | Get specific version | User |
| POST | `/api/v1/files/{id}/versions/{v}/restore` | Restore version | User |
| **Sharing** ||||
| POST | `/api/v1/files/{id}/share` | Create share link | User |
| GET | `/api/v1/share/{token}` | Access shared file | Public* |
| POST | `/api/v1/folders/{id}/share` | Share folder with user | User |
| **Admin** ||||
| GET | `/api/v1/admin/stats` | System statistics | Admin |
| GET | `/api/v1/admin/users` | List all users | Admin |
| DELETE | `/api/v1/admin/users/{id}` | Delete user | Admin |
| **Sync** ||||
| WS | `/ws` | WebSocket for sync events | User |

## Key Design Decisions

### 1. File Chunking: Fixed-Size 4MB Chunks with SHA-256

**Chosen**: Fixed 4MB chunks with SHA-256 content hashing for deduplication.

**Why fixed-size chunking works for an MVP:**
- Simple and predictable — each chunk is exactly 4MB (except the last). Upload progress bars are trivial to implement. Resume requires knowing only which chunk indices were received.
- Enables deduplication at the chunk level. If two users upload the same file, identical chunks are stored only once. Even partial overlap (e.g., same header in different documents) saves storage.
- Resumable uploads are natural — if a 100MB upload fails at chunk 15 of 25, the client resumes from chunk 15 without re-uploading the first 14 chunks.

**Why content-defined chunking (Rabin fingerprinting) was deferred:**
Content-defined chunking uses a rolling hash to find chunk boundaries based on content. This means inserting a byte at the beginning of a file only affects the first chunk, not all subsequent ones. This is critical for delta sync — sending only changed chunks on file edit. However, it adds significant implementation complexity (variable chunk sizes, boundary detection, more complex progress tracking). For the MVP, fixed chunks are sufficient.

**What we give up:** Small edits near the start of a large file cause all subsequent chunk boundaries to shift, meaning every chunk after the edit point has a different hash and must be re-uploaded. This is wasteful for large files with small edits but acceptable for the initial implementation.

### 2. Conflict Resolution: Last-Write-Wins with Conflict Copies

**Chosen**: Accept the later write as current version; preserve earlier version in history; create conflict copy if detected during sync.

**Why this works for file storage:**
- Simple to implement and reason about. No distributed consensus required.
- Version history preserves all data — nothing is lost. The earlier version is always accessible.
- Conflict copies (`filename (conflict 2024-01-15).ext`) make conflicts visible to users, who can manually choose which version to keep.
- Dropbox itself uses this approach — it's battle-tested for non-collaborative file storage.

**Why OT/CRDT was rejected:**
Operational Transformation and CRDTs enable real-time collaborative editing (Google Docs style). They require understanding file content at a semantic level (text operations, not byte-level). For a file storage service that stores arbitrary binary files, OT/CRDT is inapplicable — you cannot merge two different versions of a JPEG.

**What we give up:** Users must manually resolve conflicts. In practice, conflicts are rare for personal file storage (most users have a single device editing a file at any time).

### 3. Sync Architecture: Redis Pub/Sub + WebSocket

**Chosen**: API servers publish sync events to Redis pub/sub channels. All API servers subscribe to `sync:*` and forward events to connected WebSocket clients.

**Why this works:**
- Redis pub/sub is lightweight and fast. Publishing and receiving events adds <1ms of latency.
- No separate sync service needed — each API server handles its own WebSocket connections.
- Scales horizontally: adding more API servers automatically distributes WebSocket connections. Each server subscribes to Redis and forwards events to its local connections.

**Why not RabbitMQ for sync:**
RabbitMQ would provide guaranteed delivery with acknowledgments, but sync notifications are inherently best-effort. If a client misses a notification, it will catch up on the next folder listing or periodic poll. The overhead of guaranteed delivery (durable queues, acknowledgments, dead-letter handling) is unnecessary for ephemeral UI notifications.

**What we give up:** If Redis crashes, in-flight sync notifications are lost. Clients must handle reconnection and re-sync logic. This is acceptable because the source of truth is always PostgreSQL — notifications just optimize the sync experience.

### 4. Consistency Model

| Operation | Consistency | Mechanism |
|-----------|-------------|-----------|
| File metadata CRUD | Strong | PostgreSQL ACID transactions |
| Chunk upload | Strong | Confirm only after MinIO write succeeds |
| Folder listing | Strong read-your-writes | Cache invalidation on write |
| Sync notifications | Eventual (< 2s) | Redis pub/sub + WebSocket push |
| Dedup reference counts | Eventual | Async reconciliation job |
| Storage quota | Eventual | Updated after upload completes |

## Security

### Authentication and Authorization

| Mechanism | Implementation |
|-----------|----------------|
| Session auth | express-session with Redis store, httpOnly cookies |
| Password hashing | bcrypt with cost factor 12 |
| RBAC | Two roles: `user` (own files), `admin` (all users, system stats) |
| File permissions | Owner (full), Editor (read + write), Viewer (read only) |
| Rate limiting | 1,000 req/15min per IP, 20 req/min for auth endpoints |

### Authorization Model

| Action | Owner | Editor | Viewer |
|--------|-------|--------|--------|
| Read/Download | Yes | Yes | Yes |
| Upload/Edit | Yes | Yes | No |
| Delete | Yes | No | No |
| Share with others | Yes | No | No |
| Manage versions | Yes | No | No |

Permissions are inherited through the folder hierarchy — sharing a folder grants access to all files and subfolders within it.

### Data Protection

| Concern | Mitigation |
|---------|------------|
| Chunk access | Presigned URLs with 15-min expiry for downloads |
| Share links | Optional password (bcrypt), expiration, download limits |
| Upload validation | Verify chunk SHA-256 hash matches on server |
| Input sanitization | Filename sanitization, path traversal prevention |
| HTTPS | Required in production (TLS termination at load balancer) |

## Consistency and Idempotency

### Idempotency for Chunked Uploads

Network failures during large uploads are common. Each 4MB chunk requires a separate HTTP request, and any can fail mid-transmission. Content-addressed storage provides natural idempotency for chunk data (same hash = same storage key), but metadata operations (reference counts, session tracking) require explicit idempotency protection.

**Approach:**
- Each chunk upload uses `{uploadSessionId}-chunk-{index}` as the idempotency key
- Redis tracks processing state: pending, processing, completed
- Retried uploads receive the cached response without re-processing metadata
- Reference counts remain accurate despite retries

### Upload Session Reliability

Upload sessions expire after 24 hours. Expired sessions are cleaned up by a background job. If a client resumes an upload after session expiry, it must start a new upload session — but chunk deduplication means already-uploaded chunks won't need to be re-uploaded.

## Observability

### Metrics (Prometheus)

| Metric | Type | Purpose |
|--------|------|---------|
| `http_requests_total{method, path, status}` | Counter | Request volume and error rate |
| `http_request_duration_seconds{method, path}` | Histogram | Latency percentiles |
| `upload_chunks_total{status}` | Counter | success, duplicate, failed |
| `upload_sessions_active` | Gauge | Concurrent uploads |
| `file_downloads_total` | Counter | Download volume |
| `deduplication_ratio` | Gauge | Storage efficiency metric |
| `websocket_connections_active` | Gauge | Connected sync clients |
| `sync_events_total{type}` | Counter | Sync event volume by type |
| `circuit_breaker_state{service}` | Gauge | Dependency health |

### SLI Targets

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| API error rate (5xx) | < 0.1% | > 1% for 5m |
| Upload success rate | > 99% | < 95% for 5m |
| Sync latency p95 | < 2s | > 5s for 5m |
| Queue depth | < 1,000 | > 5,000 for 5m |
| Storage utilization | < 80% | > 95% |

### Structured Logging (Pino)

JSON logs with consistent fields: `timestamp`, `level`, `service`, `traceId`, `userId`, `message`, plus context-specific fields (fileId, chunkIndex, durationMs). Trace IDs propagate via `X-Trace-Id` header for cross-service correlation.

## Failure Handling

### Retry Strategies

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Chunk upload to MinIO/S3 | 3 | Exponential (1s, 2s, 4s) | Safe: PUT is idempotent by hash |
| Metadata write | 2 | Fixed 500ms | Transaction with rollback |
| Sync notification | 3 | Exponential | Clients dedupe by eventId |
| Download stream | 0 | N/A | Client resumes with Range header |

### Circuit Breakers

Applied to MinIO/S3 operations using the cockatiel library. Opens after 5 consecutive failures, resets after 30 seconds. When open:

| Failure | Degraded Behavior |
|---------|-------------------|
| MinIO/S3 down | Reject uploads with 503, downloads fail gracefully |
| PostgreSQL down | All API requests fail, alert immediately |
| Redis down | Users logged out, cache cold, operations continue via DB |
| Worker crash | Unacked messages requeued, process manager restarts |
| Upload interrupted | Client resumes from last confirmed chunk |

### Graceful Shutdown

On SIGTERM/SIGINT: stop accepting new HTTP connections, close WebSocket connections with code 1001, unsubscribe from Redis pub/sub, close database pool, then exit.

## Scalability Considerations

### Horizontal Scaling Path

**Phase 1: Multi-instance** — 3 API servers behind nginx. Shared PostgreSQL + Redis + MinIO + RabbitMQ. WebSocket connections distributed across servers; Redis pub/sub ensures all servers receive sync events.

**Phase 2: Read replicas** — PostgreSQL primary + 2 read replicas for folder listings and file searches. Partition chunks table by hash prefix for parallel access.

**Phase 3: Geo-distribution** — Multi-region S3 replication. CDN for popular shared files. Regional API servers with global metadata replication.

### What Breaks First

1. **Object storage I/O** at ~100,000 concurrent uploads — mitigated by S3's massive parallelism and content-addressed deduplication
2. **PostgreSQL connections** at ~10,000 concurrent metadata queries — mitigated by connection pooling (PgBouncer), read replicas, and folder listing cache
3. **WebSocket connections** at ~1,000 per server — mitigated by adding API servers; Redis pub/sub handles cross-server sync

### Future Optimizations

1. **Delta sync**: Content-defined chunking (Rabin fingerprinting) for efficient edits
2. **Edge caching**: CDN for popular shared files
3. **Compression**: LZ4 compression for chunks before storage
4. **Client-side encryption**: User-held keys for end-to-end encryption
5. **Smart sync**: Prioritize recently accessed files, lazy-load old files

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Chunk strategy | Fixed 4MB | Rabin fingerprinting | Simpler; deferred content-defined for delta sync |
| Conflict resolution | Last-write-wins + copies | OT/CRDT | Binary files can't be merged; copies are safe |
| Sync transport | Redis pub/sub + WebSocket | RabbitMQ fanout | Lightweight; notifications are best-effort |
| Metadata DB | PostgreSQL | CouchDB | Need strong consistency for file operations |
| Object storage | S3 (MinIO locally) | Local filesystem | S3 scales; filesystem doesn't replicate |
| Session storage | Redis + cookie | JWT | Immediate revocation, quota tracking |
| Queue technology | RabbitMQ | Kafka | Simpler operations; sufficient for background jobs |

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (bare Outlet, no shared layout)
├── / (FileBrowser) [auth required]
│   ├── Sidebar (navigation: files, shared with me, storage quota)
│   ├── Breadcrumbs (folder path navigation)
│   ├── UploadZone (drag-and-drop + upload button + progress overlay)
│   ├── FileListItem (per-file row with actions)
│   ├── CreateFolderModal
│   ├── ShareModal (create share links, folder sharing)
│   ├── VersionHistoryModal (version list + restore)
│   └── MoveModal (move file/folder to different parent)
├── /login (LoginPage)
├── /register (RegisterPage)
├── /admin (AdminPage) [admin role required]
├── /settings (SettingsPage)
└── /shared (SharedFilePage) [public, token-based access]
```

The root route (`__root.tsx`) is minimal -- it renders only an `<Outlet />` with no shared header or footer. Each route manages its own full-page layout. The main file browser at `/` uses a sidebar + main content layout with the sidebar providing navigation between "My Files" and "Shared with me" views.

### TanStack Router Structure

The project uses TanStack Router's file-based routing. The root route at `/` accepts an optional `folder` search parameter (`?folder={folderId}`) for navigating into subfolders without changing the URL path. This means all folder navigation stays on the `/` route and updates only the query string.

| Route File | Path | Purpose |
|------------|------|---------|
| `__root.tsx` | N/A | Bare Outlet wrapper |
| `index.tsx` | `/` | Main file browser with `?folder=` search param |
| `login.tsx` | `/login` | Login form |
| `register.tsx` | `/register` | Registration form |
| `admin.tsx` | `/admin` | Admin dashboard (system stats, user management) |
| `settings.tsx` | `/settings` | User settings |
| `shared.tsx` | `/shared` | Public shared file access (token-based) |

Route validation is implemented in the index route using `validateSearch` to extract and type the `folder` search parameter. Auth checks use `useEffect` to redirect unauthenticated users to `/login`.

### Zustand Stores

**`authStore`** -- Manages user authentication state with `persist` middleware. Unlike the other projects, this store persists the session `token` (not the user object) to localStorage, allowing session restoration on page reload. Provides `login`, `register`, `logout`, and `checkAuth` actions. `checkAuth` calls `GET /api/auth/me` to refresh the user object from the server.

**`fileStore`** -- The most complex store in any of the four projects. Manages the current folder view, upload queue, and file selection state. Key fields:
- `currentFolder`: Contains the folder metadata, breadcrumbs array, and items list for the currently displayed folder.
- `uploadingFiles`: An array of upload tracking objects with per-file progress (0-100%), status (`pending`/`uploading`/`completed`/`error`), and error messages.
- `selectedItems`: A `Set<string>` of selected file/folder IDs for future bulk operations.

The store provides `loadFolder(folderId?)` for navigation, `uploadFile(file)` which manages the full upload lifecycle including progress tracking, and CRUD operations (`createFolder`, `deleteItem`, `renameItem`, `moveItem`) that automatically refresh the current folder view after completion.

### Data Fetching Pattern

API calls are organized by resource across four exported objects in `frontend/src/services/api.ts`: `authApi`, `filesApi`, `sharingApi`, and `adminApi`. Each uses a shared `request<T>()` helper that wraps `fetch` with credentials, JSON headers, and error handling.

File uploads use `XMLHttpRequest` instead of `fetch` because XHR supports `upload.onprogress` events for tracking upload progress -- the `fetch` API does not provide upload progress callbacks. The `filesApi.uploadFile` method returns a Promise that resolves when the upload completes, while calling an `onProgress` callback with percentage values during transfer.

File downloads use raw `fetch` (bypassing the JSON wrapper) and return the Response object directly, allowing the caller to stream the binary response or create a download link.

### Real-Time Updates

The Dropbox frontend connects to the backend via WebSocket (`/ws?token={sessionToken}`) for real-time sync notifications. When another device or browser tab uploads, deletes, or moves a file, the server publishes a sync event via Redis pub/sub, and all connected WebSocket clients for that user receive a notification. The client then calls `loadFolder()` to refresh the current folder view. This is a notification-driven refresh pattern -- the WebSocket message triggers a full API call rather than carrying the updated data inline.

### Key UI Patterns

**Drag-and-drop upload zone**: The `UploadZone` component uses `react-dropzone` to detect files dragged over the browser window. When files are dropped, each file is passed to `fileStore.uploadFile()`, which tracks upload progress in the `uploadingFiles` array. A floating progress panel in the bottom-right corner shows per-file upload status with animated progress bars. Completed uploads auto-dismiss after 3 seconds.

**Breadcrumb navigation**: The `Breadcrumbs` component renders the folder hierarchy as clickable path segments. Clicking a breadcrumb navigates to that folder by updating the `?folder=` search parameter. The breadcrumb data comes from the API response (`currentFolder.breadcrumbs`), which includes the full path from root to the current folder.

**Modal-driven file operations**: Sharing, version history, moving, and folder creation each use dedicated modal components. The parent `FileBrowser` manages modal visibility via state variables (`shareItem`, `versionItem`, `moveModalItem`, `showCreateFolder`). Each modal receives the relevant file/folder item and a callback for the operation.

**Folder navigation via query string**: Instead of using nested routes (`/folder/abc/folder/def`), the file browser uses a single route with `?folder={id}`. This simplifies routing but means the browser's back/forward buttons navigate between folder views correctly via the query string history.

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend, why it matters for a cloud storage service, and how it works in practice.

### RBAC (Role-Based Access Control)

**What it is:** RBAC is a method of restricting system access based on roles assigned to users rather than checking individual permissions for each action. Instead of maintaining a list of "user X can do Y on resource Z" for every possible combination, the system assigns each user a role and defines what each role can do.

**Why Dropbox needs it:** A cloud storage service has a layered permission model. At the system level, there are two roles: regular users (who manage their own files) and admins (who manage all users, view system stats, and run maintenance). At the file/folder level, there are three access levels: Owner (full control), Editor (read + write), and Viewer (read only). Without RBAC, there would be no way to distinguish between a user viewing their own files, a collaborator editing a shared folder, and an admin managing storage quotas. The folder hierarchy adds complexity because permissions inherit downward -- sharing a folder grants access to all files and subfolders within it.

**How it works here:** The `users` table has a `role` column (`user` or `admin`). The `folder_shares` table maps folder-to-user relationships with an `access_level` column (`view`, `edit`, `owner`). The auth middleware in `backend/src/middleware/auth.ts` validates the session and attaches the user object (including role) to the request. File operation endpoints check both the system role (for admin access) and the per-file ownership/sharing permissions (for collaborator access). The authorization check walks up the folder hierarchy to find inherited shares.

### Redis Cache-Aside

**What it is:** Cache-aside (also called lazy-loading) is a caching strategy where the application checks the cache first for each read request. On a cache hit, the cached value is returned immediately. On a cache miss, the application queries the database, stores the result in the cache, and returns it. The application explicitly manages cache population and invalidation.

**Why Dropbox needs it:** Folder listing is the most frequently called operation in a file storage service -- every time a user navigates to a folder, opens the app, or refreshes the page, the server must query all files and subfolders. Without caching, each folder navigation queries PostgreSQL with joins across the `files` table, potentially scanning thousands of rows for users with many files. With cache-aside, repeated views of the same folder (which is the common case -- users spend most time in a few folders) return instantly from Redis.

**How it works here:** The Redis key pattern `cache:folder:{folderId}:listing` stores the serialized JSON of a folder's contents with a 5-minute TTL. On folder navigation, the server checks this key first. On any write operation that affects a folder (file upload, delete, rename, move, folder creation), the cache for the affected folder is invalidated via `redis.del()`. The root folder has a separate key pattern (`cache:folder:root:{userId}:listing`) because root folders are user-specific. File metadata is cached separately at `cache:file:{fileId}` with a 10-minute TTL for individual file lookups.

### Circuit Breaker

**What it is:** A circuit breaker is a stability pattern that monitors calls to an external dependency and stops sending requests when the dependency is failing. It has three states: Closed (normal operation, requests pass through), Open (dependency is failing, requests are rejected immediately without attempting the call), and Half-Open (a test request is allowed through after a cooldown period to check if the dependency has recovered).

**Why Dropbox needs it:** The API server depends on PostgreSQL, Redis, and MinIO (S3-compatible object storage). MinIO is particularly critical because file uploads and downloads directly interact with it. If MinIO becomes unresponsive (disk full, network partition), continuing to send upload requests would cause all upload handlers to hang waiting for timeouts, exhausting the Node.js event loop and making the entire API unresponsive -- even for operations that do not need MinIO (like folder listing from cache, authentication). The circuit breaker detects MinIO failures and immediately rejects upload attempts with 503, keeping the rest of the API responsive.

**How it works here:** The circuit breaker in `backend/src/shared/circuitBreaker.ts` uses the `cockatiel` library (rather than Opossum used in other projects). It wraps MinIO operations (chunk upload, chunk download, chunk existence check) with a circuit that opens after 5 consecutive failures and resets after 30 seconds. Retry logic is built into the same module: 3 retries with exponential backoff and jitter for transient storage failures. The circuit breaker state is exposed as a Prometheus gauge (`circuit_breaker_state`) and reported in the health check response, allowing the load balancer to route traffic away from instances with open circuits.

### Structured Logging

**What it is:** Structured logging emits log entries as machine-parseable JSON objects with consistent, typed fields rather than free-form text strings. Each log entry has a fixed schema (timestamp, level, service, message) plus context-specific fields that allow log aggregation tools to filter, search, and correlate events across distributed services.

**Why Dropbox needs it:** A cloud storage service generates diverse log events: file uploads (with chunk index, hash, dedup status), downloads (with file ID, byte range), sync notifications (with user ID, event type), share link access (with token, password validation result), and version operations (with file ID, version number). Without structured logging, searching for "all operations on file X" requires parsing unstructured text. With structured fields like `{ "fileId": "abc", "operation": "upload", "chunkIndex": 3, "dedup": true }`, operators can query `fileId = "abc"` to see the complete lifecycle of a file across all operations.

**How it works here:** The logger in `backend/src/shared/logger.ts` uses Pino configured with JSON output in production and pretty-printed output in development. Each log entry includes: `timestamp`, `level`, `service` (identifying the API instance), `traceId` (propagated via `X-Trace-Id` header for cross-service correlation), `userId`, and `message`. Child loggers created per-request inherit the trace ID and user ID, ensuring all log entries within a single request are automatically correlated. Upload operations add `chunkIndex`, `chunkHash`, and `dedup` fields. Download operations add `fileId` and byte range fields.

### Prometheus Metrics

**What it is:** Prometheus is a pull-based monitoring system that periodically scrapes metric values from application HTTP endpoints. Applications expose a `/metrics` endpoint with time-series data in Prometheus text format. Metrics are categorized as counters (values that only increase, like total requests), gauges (values that go up and down, like active connections), and histograms (distributions of values, like request latency).

**Why Dropbox needs it:** A cloud storage service must monitor several critical dimensions that are invisible without instrumentation. Upload success rate tells operators if MinIO is healthy. Deduplication ratio reveals how much storage is being saved. WebSocket connection count indicates sync load. Upload session duration shows if large uploads are completing or timing out. Queue depth reveals if background jobs (garbage collection, sync notifications) are keeping up. Without metrics, operators discover storage failures only when users report "upload failed" -- by which point many users may be affected.

**How it works here:** The `backend/src/shared/metrics.ts` file registers metrics using `prom-client`. Key metrics: `http_requests_total` and `http_request_duration_seconds` (standard request monitoring), `upload_chunks_total` (counter labeled by status: success/duplicate/failed -- the "duplicate" label tracks deduplication effectiveness), `upload_sessions_active` (gauge for concurrent uploads), `file_downloads_total` (counter), `deduplication_ratio` (gauge), `websocket_connections_active` (gauge for sync clients), `sync_events_total` (counter by event type), and `circuit_breaker_state` (gauge per dependency). Path normalization replaces UUIDs in metric labels with placeholders to prevent high cardinality (e.g., `/files/file/{id}/download` instead of `/files/file/abc-123/download`).

### Rate Limiting

**What it is:** Rate limiting restricts how many requests a client can make within a time window. When the limit is exceeded, the server returns HTTP 429 (Too Many Requests). Limits are typically per-IP for anonymous endpoints and per-user for authenticated endpoints, tracked using atomic counters in Redis with TTL-based expiration.

**Why Dropbox needs it:** File upload is the most resource-intensive operation in a storage service -- each upload consumes network bandwidth, object storage I/O, database connections, and disk space. Without rate limiting, a single user running an automated upload script could saturate the server's upload bandwidth, fill storage quotas of shared infrastructure, or exhaust database connections. Rate limiting also protects against brute-force attacks on share link passwords (which use bcrypt, an intentionally slow operation) and prevents abuse of the auth endpoints.

**How it works here:** Rate limiting is implemented in `backend/src/index.ts` using `express-rate-limit`. Two tiers: general API requests (1,000 requests per 15 minutes per IP) and auth endpoints (20 requests per minute per IP, protecting against brute-force login attempts). Upload-specific rate limiting uses Redis counters at `ratelimit:{userId}:upload` with a 1-minute TTL to prevent individual users from monopolizing upload capacity. The Redis key pattern `ratelimit:{ip}:api` tracks per-IP API usage.

### Idempotency

**What it is:** Idempotency guarantees that performing the same operation multiple times produces the same result as performing it once. For file uploads, this means that if a chunk upload request is retried (due to network timeout or client retry logic), the chunk is not stored twice, the reference count is not incremented twice, and the upload session progress is not double-counted.

**Why Dropbox needs it:** Chunked file uploads are inherently retry-prone. A 1GB file split into 4MB chunks requires 256 separate HTTP requests, any of which can fail due to network issues. If a chunk upload succeeds on the server but the response is lost in transit, the client will retry the same chunk. Without idempotency, the retry would increment the chunk's `reference_count` from 1 to 2, causing the chunk to persist even after the file is deleted (because the garbage collector sees `reference_count > 0`). Content-addressed storage provides natural data idempotency (same hash = same storage key, so re-uploading is a no-op at the storage layer), but metadata operations require explicit protection.

**How it works here:** The idempotency middleware in `backend/src/shared/idempotency.ts` uses the composite key `{uploadSessionId}-chunk-{index}` as the idempotency key. Redis tracks the processing state for each chunk: `pending` (being processed), `completed` (successfully stored). If a retry arrives for a chunk marked `completed`, the middleware returns the cached successful response without re-executing the upload logic. The reference count increment is wrapped in the same idempotency boundary, ensuring it is incremented exactly once regardless of retries.

### Health Checks

**What it is:** Health check endpoints report whether an application instance is functioning correctly and can serve traffic. They are consumed by load balancers, container orchestrators, and monitoring systems. A typical health check system provides three tiers: liveness (is the process running?), readiness (can it handle requests?), and deep (are all dependencies responsive and within latency thresholds?).

**Why Dropbox needs it:** A cloud storage service depends on three critical external services: PostgreSQL (metadata), Redis (sessions and cache), and MinIO (file chunks). If MinIO is down, the instance cannot serve uploads or downloads but can still serve folder listings from cache and handle authentication. A readiness check that requires all three services would unnecessarily remove the instance from rotation. The three-tier health check model allows the load balancer to make nuanced decisions: route metadata-only requests to instances with PostgreSQL + Redis, but skip instances with MinIO failures for upload/download traffic.

**How it works here:** Three endpoints are implemented in `backend/src/routes/health.ts`: `/health/live` returns 200 if the process is alive (Kubernetes liveness probe -- if this fails, the container should be restarted). `/health/ready` checks PostgreSQL and Redis connectivity and returns 200 only if both are reachable (load balancer health check -- if this fails, stop sending traffic). `/health/deep` performs dependency-by-dependency health checks with latency measurements, returning a JSON report like `{ "postgres": { "status": "up", "latency_ms": 3 }, "redis": { "status": "up", "latency_ms": 1 }, "minio": { "status": "down", "error": "connection refused" } }`. The deep check is used by monitoring dashboards and alerting, not by load balancers (it is too expensive to run on every health check interval).

## Implementation Notes

This section documents the actual local development setup and maps production design decisions to the working implementation.

### Local Architecture

```
┌─────────────────┐
│   Web Browser   │
│   (React app)   │
│   Port 5173     │
└───┬─────────┬───┘
    │ HTTP    │ WS
    ▼         ▼
┌─────────────────┐
│  API Server     │
│  (Express.js)   │
│  Port 3000      │
│  REST + WS      │
└────────┬────────┘
         │
    ┌────┼──────────────────┐
    │    │                  │
    ▼    ▼                  ▼
┌──────┐ ┌──────────┐ ┌──────────┐
│Redis │ │PostgreSQL│ │  MinIO   │
│:6379 │ │  :5432   │ │:9000/:9001│
└──────┘ └──────────┘ └──────────┘
```

All infrastructure runs via Docker Compose. A single API server handles both REST and WebSocket connections. Multiple instances can be run on ports 3001-3003 for distributed testing. Note: No RabbitMQ in local setup — sync uses Redis pub/sub directly.

### Production Patterns Actually Implemented

| Pattern | File Path | Description |
|---------|-----------|-------------|
| Idempotency middleware | `backend/src/shared/idempotency.ts` | Redis-backed dedup for chunk uploads; prevents reference count drift on retries |
| Circuit breakers (cockatiel) | `backend/src/shared/circuitBreaker.ts` | Wraps MinIO operations; opens after 5 consecutive failures, resets after 30s |
| Retry with exponential backoff | `backend/src/shared/circuitBreaker.ts` | 3 retries with jitter for storage operations |
| Prometheus metrics (prom-client) | `backend/src/shared/metrics.ts` | HTTP requests, upload chunks, WebSocket connections, sync events, dedup ratio |
| Structured logging (Pino) | `backend/src/shared/logger.ts` | JSON logs with trace IDs, request context, pretty printing in dev |
| Health checks (3-tier) | `backend/src/routes/health.ts` | `/health/live`, `/health/ready`, `/health/deep` with dependency latencies |
| WebSocket sync | `backend/src/index.ts` | Redis pub/sub subscription, authenticated WebSocket connections, sync fanout |
| Chunked upload with dedup | `backend/src/services/file/upload.ts` | SHA-256 hashing, chunk existence check, reference counting |
| File versioning | `backend/src/services/file/versioning.ts` | Version history with chunk references; restore to any previous version |
| RBAC permissions | `backend/src/middleware/auth.ts` | Owner/Editor/Viewer roles; folder hierarchy inheritance |
| Soft deletes (trash) | `backend/src/db/init.sql` | `deleted_at` column with filtered unique constraints |
| Share links | `backend/src/services/sharingService.ts` | Password-protected, expiring, download-limited share URLs |
| Rate limiting | `backend/src/index.ts` | express-rate-limit: 1,000 req/15min per IP |
| Request tracing | `backend/src/index.ts` | X-Trace-Id header propagation, request-scoped loggers |
| Graceful shutdown | `backend/src/index.ts` | SIGTERM/SIGINT handlers close WS, Redis, and DB connections |
| Path normalization for metrics | `backend/src/index.ts` | Replaces UUIDs and IDs in paths to avoid high cardinality |

### What Was Simplified or Substituted

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| S3 multi-region | MinIO single instance (Docker) | No replication; single point of failure for chunks |
| Redis Cluster | Single Valkey instance (Docker) | No partitioning; sufficient for dev scale |
| PostgreSQL primary + replicas | Single PostgreSQL instance (Docker) | No read replicas |
| RabbitMQ for background jobs | Redis pub/sub only | No durable queues; sync notifications only |
| nginx load balancer | Direct connection to single API server | Can run 3 instances manually on ports 3001-3003 |
| CDN for shared files | Direct MinIO download | No edge caching |
| Content-defined chunking | Fixed 4MB chunks | Suboptimal delta sync |
| OAuth / social login | Email + password with bcrypt | Simpler auth flow |
| Client-side encryption | Plaintext storage in MinIO | No end-to-end encryption |

### What Was Omitted

- Desktop sync client (file system watcher, daemon process)
- Content-defined chunking (Rabin fingerprinting) for delta sync
- Client-side encryption with user-held keys
- CDN / edge caching for popular shared files
- Multi-region replication and geo-routing
- Kubernetes orchestration
- Database sharding
- Compression of chunks (LZ4) before storage
- Smart sync (prioritize recent files, lazy-load old)
- Storage tiering (hot/warm/cold with different S3 classes)
- Garbage collection job for orphaned chunks with reference_count = 0
