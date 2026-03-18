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
