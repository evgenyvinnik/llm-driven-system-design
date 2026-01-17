# Dropbox - Cloud Storage - Architecture Design

## System Overview

A cloud file storage and synchronization service enabling users to upload, download, sync, share, and version files across multiple devices. This design targets local development and learning, simulating distributed system behavior with 2-5 service instances.

## Requirements

### Functional Requirements

- **File upload/download**: Support files up to 10GB with chunked upload/download
- **Sync across devices**: Real-time sync notifications, conflict detection
- **File sharing**: Share links (public/password-protected), folder sharing with specific users
- **Version history**: Track file versions, restore previous versions, configurable retention
- **Folder hierarchy**: Create, rename, move, delete folders; nested structure support

### Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Availability | 99.9% (8.7h downtime/year) | Standard for file storage; local dev uses single instances |
| Upload latency | < 100ms for chunk acknowledgment | User perceives upload as responsive |
| Download latency | < 50ms time-to-first-byte (metadata) | File browser feels instant |
| Sync latency | < 2s for change propagation | Near real-time sync experience |
| Consistency | Strong for metadata, eventual for sync notifications | Users expect their view to be current |
| Durability | No data loss for committed uploads | Chunks confirmed only after MinIO write succeeds |

## Capacity Estimation

### Local Development Scale

These numbers are for learning/testing. Production would be 1000x larger.

| Metric | Value | Calculation |
|--------|-------|-------------|
| Daily Active Users (DAU) | 10-50 | Local testing with simulated users |
| Concurrent users | 5-10 | Realistic for dev machine |
| Peak upload RPS | 20 | 10 users * 2 concurrent uploads |
| Peak download RPS | 50 | 10 users * 5 concurrent downloads |
| Peak metadata RPS | 100 | Folder listings, search, file info |
| Avg file size | 5 MB | Mix of documents, images, small videos |
| Files uploaded/day | 500 | 50 users * 10 files/day |
| Daily storage growth | 2.5 GB | 500 files * 5 MB (before dedup) |
| Storage after 30 days | ~50 GB | With ~30% deduplication savings |

### Component Sizing (Local Dev)

| Component | Sizing | Notes |
|-----------|--------|-------|
| PostgreSQL | 1 instance, 1GB RAM | 100k files = ~50MB metadata |
| MinIO | 1 instance, 100GB disk | Single bucket, versioning enabled |
| Redis/Valkey | 1 instance, 256MB RAM | Sessions + 1000 cached folder listings |
| RabbitMQ | 1 instance, 256MB RAM | Sync notifications, background jobs |
| API Server | 2-3 instances, 512MB each | Behind load balancer for testing |

## High-Level Architecture

```
                                    +------------------+
                                    |   Load Balancer  |
                                    |   (nginx:3000)   |
                                    +--------+---------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
    +---------v---------+          +---------v---------+          +---------v---------+
    |   API Server 1    |          |   API Server 2    |          |   API Server 3    |
    |   (Express:3001)  |          |   (Express:3002)  |          |   (Express:3003)  |
    +---+-------+-------+          +---+-------+-------+          +---+-------+-------+
        |       |                      |       |                      |       |
        |       +----------------------+-------+----------------------+       |
        |                              |                                      |
        v                              v                                      v
+-------+-------+              +-------+-------+                      +-------+-------+
|   PostgreSQL  |              |  Redis/Valkey |                      |    RabbitMQ   |
|   (Metadata)  |              |   (Sessions   |                      | (Async Jobs)  |
|   Port: 5432  |              |    + Cache)   |                      |  Port: 5672   |
+---------------+              |   Port: 6379  |                      +-------+-------+
                               +---------------+                              |
                                                                              v
                               +---------------+                      +-------+-------+
                               |     MinIO     |                      | Sync Workers  |
                               | (Chunk Store) |                      | (Background)  |
                               |   Port: 9000  |                      +---------------+
                               +---------------+
```

### Core Components

| Component | Responsibility | Technology |
|-----------|----------------|------------|
| **API Server** | HTTP API, authentication, request routing | Express + TypeScript |
| **Metadata Store** | Files, folders, users, shares, versions | PostgreSQL |
| **Chunk Store** | Binary file chunks, content-addressed | MinIO (S3-compatible) |
| **Session/Cache** | User sessions, folder listing cache | Redis/Valkey |
| **Message Queue** | Sync notifications, background jobs | RabbitMQ |
| **Sync Workers** | Process uploads, trigger sync events | Node.js workers |
| **Load Balancer** | Distribute requests, health checks | nginx |

## Request Flows

### File Upload Flow

```
1. Client: POST /api/v1/files/upload/init
   Body: { filename, size, parentFolderId }
   Response: { uploadId, chunkSize: 4MB }

2. Client: Compute SHA-256 hash for each chunk locally

3. Client: POST /api/v1/files/upload/{uploadId}/chunks/check
   Body: { chunkHashes: ["abc123...", "def456...", ...] }
   Response: { needed: [0, 2, 5], existing: [1, 3, 4] }  // Indices of chunks to upload

4. For each needed chunk:
   Client: PUT /api/v1/files/upload/{uploadId}/chunks/{index}
   Body: <binary chunk data>
   Response: { received: true, hash: "abc123..." }

   Server actions:
   - Validate chunk hash matches
   - Store chunk in MinIO: bucket/chunks/{hash}
   - Increment chunk reference_count if exists, else insert

5. Client: POST /api/v1/files/upload/{uploadId}/complete
   Response: { fileId, version: 1 }

   Server actions:
   - Create file record in PostgreSQL
   - Create file_version record linking to chunks
   - Publish sync event to RabbitMQ
   - Invalidate parent folder cache in Redis
```

### File Download Flow

```
1. Client: GET /api/v1/files/{fileId}
   Response: {
     id, name, size, version,
     chunks: [{ index: 0, hash: "abc123", size: 4194304 }, ...],
     downloadUrl: "/api/v1/files/{fileId}/download"
   }

2. Client: GET /api/v1/files/{fileId}/download
   Optional: Range header for partial download

   Server actions:
   - Stream chunks from MinIO in order
   - Support byte-range requests for resume

   Response: Binary stream with Content-Disposition header
```

### Sync Notification Flow

```
1. Client connects: WS /api/v1/sync/ws
   Server: Register client for user's sync events

2. On file change (upload/delete/rename):
   API Server: Publish to RabbitMQ exchange "sync.events"
   Routing key: "user.{userId}.change"

3. Sync Worker: Consume from queue, fan out to connected WebSockets

4. Client receives: { type: "file_changed", fileId, action: "created" }
   Client: Refresh local state, download if needed
```

## Data Model

### Database Schema (PostgreSQL)

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    storage_quota_bytes BIGINT DEFAULT 10737418240, -- 10GB default
    storage_used_bytes BIGINT DEFAULT 0,
    role VARCHAR(20) DEFAULT 'user', -- 'user' | 'admin'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Folders table (self-referential for hierarchy)
CREATE TABLE folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id),
    parent_id UUID REFERENCES folders(id), -- NULL = root folder
    name VARCHAR(255) NOT NULL,
    path TEXT NOT NULL, -- Materialized path: "/folder1/folder2"
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ, -- Soft delete for trash

    UNIQUE(owner_id, parent_id, name) WHERE deleted_at IS NULL
);
CREATE INDEX idx_folders_owner_parent ON folders(owner_id, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_folders_path ON folders(path);

-- Files table (metadata only, chunks stored in MinIO)
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id),
    folder_id UUID REFERENCES folders(id), -- NULL = user's root
    name VARCHAR(255) NOT NULL,
    size_bytes BIGINT NOT NULL,
    mime_type VARCHAR(100),
    current_version INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ, -- Soft delete for trash

    UNIQUE(owner_id, folder_id, name) WHERE deleted_at IS NULL
);
CREATE INDEX idx_files_folder ON files(folder_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_owner ON files(owner_id) WHERE deleted_at IS NULL;

-- Chunks table (content-addressed, shared via deduplication)
CREATE TABLE chunks (
    hash VARCHAR(64) PRIMARY KEY, -- SHA-256 hex
    size_bytes INTEGER NOT NULL,
    reference_count INTEGER DEFAULT 1,
    storage_bucket VARCHAR(100) DEFAULT 'chunks',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- File versions (each version references a set of chunks)
CREATE TABLE file_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    size_bytes BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id),

    UNIQUE(file_id, version_number)
);
CREATE INDEX idx_file_versions_file ON file_versions(file_id);

-- Version-to-chunk mapping (ordered)
CREATE TABLE version_chunks (
    version_id UUID REFERENCES file_versions(id) ON DELETE CASCADE,
    chunk_hash VARCHAR(64) REFERENCES chunks(hash),
    chunk_index INTEGER NOT NULL, -- Order within file

    PRIMARY KEY(version_id, chunk_index)
);

-- Upload sessions (for resumable uploads)
CREATE TABLE upload_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    folder_id UUID REFERENCES folders(id),
    filename VARCHAR(255) NOT NULL,
    total_size BIGINT NOT NULL,
    chunk_size INTEGER DEFAULT 4194304, -- 4MB
    total_chunks INTEGER NOT NULL,
    received_chunks INTEGER[] DEFAULT '{}', -- Array of received chunk indices
    status VARCHAR(20) DEFAULT 'pending', -- pending, completed, expired
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);
CREATE INDEX idx_upload_sessions_user ON upload_sessions(user_id, status);

-- Share links (public or password-protected)
CREATE TABLE share_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id UUID REFERENCES files(id) ON DELETE CASCADE,
    folder_id UUID REFERENCES folders(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id),
    token VARCHAR(32) UNIQUE NOT NULL, -- Short URL token
    password_hash VARCHAR(255), -- NULL = no password
    expires_at TIMESTAMPTZ,
    max_downloads INTEGER,
    download_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    CHECK (file_id IS NOT NULL OR folder_id IS NOT NULL)
);
CREATE INDEX idx_share_links_token ON share_links(token);

-- Folder shares (with specific users)
CREATE TABLE folder_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    shared_with UUID NOT NULL REFERENCES users(id),
    permission VARCHAR(20) DEFAULT 'read', -- 'read' | 'write'
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(folder_id, shared_with)
);
CREATE INDEX idx_folder_shares_user ON folder_shares(shared_with);
```

### MinIO Bucket Structure

```
dropbox-chunks/
  chunks/
    {sha256-hash}          # Raw chunk data, no extension
                           # Example: chunks/a1b2c3d4e5...

dropbox-temp/
  uploads/
    {upload-session-id}/
      {chunk-index}        # Temporary storage during upload
```

### Redis Key Structure

```
# Session storage (express-session)
sess:{sessionId}                    # User session data, TTL: 24h

# Cache: Folder listings
cache:folder:{folderId}:listing     # JSON array of files/folders, TTL: 5m
cache:folder:root:{userId}:listing  # Root folder listing, TTL: 5m

# Cache: File metadata
cache:file:{fileId}                 # File metadata JSON, TTL: 10m

# Rate limiting
ratelimit:{userId}:upload           # Upload rate counter, TTL: 1m
ratelimit:{ip}:api                  # API rate counter, TTL: 1m

# Active upload tracking
upload:active:{uploadId}            # Upload session status, TTL: 25h
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
| GET | `/api/v1/files/{id}/download` | Download file | User |
| DELETE | `/api/v1/files/{id}` | Soft delete file | User |
| POST | `/api/v1/files/{id}/restore` | Restore from trash | User |
| **Upload (Chunked)** ||||
| POST | `/api/v1/upload/init` | Start upload session | User |
| POST | `/api/v1/upload/{id}/check` | Check which chunks exist | User |
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
| POST | `/api/v1/folders/{id}/share` | Share with user | User |
| **Admin** ||||
| GET | `/api/v1/admin/stats` | System statistics | Admin |
| GET | `/api/v1/admin/users` | List all users | Admin |
| DELETE | `/api/v1/admin/users/{id}` | Delete user | Admin |
| **Sync** ||||
| WS | `/api/v1/sync/ws` | WebSocket for sync events | User |

### Request/Response Examples

**Upload Init:**
```json
// POST /api/v1/upload/init
// Request:
{
  "filename": "presentation.pdf",
  "size": 15728640,
  "folderId": "550e8400-e29b-41d4-a716-446655440000",
  "mimeType": "application/pdf"
}

// Response (201 Created):
{
  "uploadId": "660e8400-e29b-41d4-a716-446655440000",
  "chunkSize": 4194304,
  "totalChunks": 4,
  "expiresAt": "2024-01-02T12:00:00Z"
}
```

**Chunk Check (Deduplication):**
```json
// POST /api/v1/upload/{uploadId}/check
// Request:
{
  "chunkHashes": [
    "a1b2c3d4e5f6...",
    "b2c3d4e5f6a1...",
    "c3d4e5f6a1b2...",
    "d4e5f6a1b2c3..."
  ]
}

// Response:
{
  "needed": [0, 2],      // Upload these chunks
  "existing": [1, 3]     // Already stored (deduped)
}
```

## Key Design Decisions

### File Chunking and Deduplication

**Decision:** 4MB fixed-size chunks with SHA-256 content hashing

| Approach | Pros | Cons |
|----------|------|------|
| **Fixed-size (chosen)** | Simple implementation, predictable | Insertion shifts all boundaries |
| Content-defined (Rabin) | Better delta sync, edit-friendly | Complex, variable chunk sizes |
| No chunking | Simplest | No dedup, large transfers |

**Deduplication flow:**
1. Client computes SHA-256 for each 4MB chunk
2. Server checks which hashes already exist in `chunks` table
3. Client only uploads missing chunks
4. Server increments `reference_count` for existing chunks
5. On file delete, decrement count; garbage collect at count=0

**Trade-off:** Fixed chunks mean small edits near file start cause all subsequent chunks to differ. Acceptable for MVP; content-defined chunking is a future optimization.

### Conflict Resolution Strategy

**Decision:** Last-write-wins with conflict copy creation

When two devices modify the same file before syncing:
1. Server accepts the later write as the new current version
2. Earlier version is preserved in version history
3. If detected during sync, client creates a conflict copy: `filename (conflict 2024-01-15).ext`
4. User manually resolves by choosing which to keep

**Why not OT/CRDT?** Overkill for file sync. Dropbox uses this approach; works well for non-collaborative editing.

### Consistency Model

| Operation | Consistency | Implementation |
|-----------|-------------|----------------|
| File metadata CRUD | Strong | PostgreSQL ACID transactions |
| Chunk upload | Strong | Confirm after MinIO write succeeds |
| Folder listing | Strong read-your-writes | Cache invalidation on write |
| Sync notifications | Eventual (< 2s) | RabbitMQ fanout, WebSocket push |
| Dedup reference counts | Eventual | Async worker reconciliation |

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Application** | Node.js + Express + TypeScript | Fast iteration, async I/O, familiar |
| **Metadata DB** | PostgreSQL 16 | ACID, foreign keys, hierarchical queries |
| **Object Store** | MinIO | S3-compatible, local dev friendly, production-ready |
| **Cache/Sessions** | Redis 7 / Valkey | Session storage, folder cache, rate limits |
| **Message Queue** | RabbitMQ | Sync events, background jobs, dead letter queue |
| **Load Balancer** | nginx | Simple, reliable, health checks |
| **Monitoring** | Prometheus + Grafana | Metrics collection and dashboards |

## Caching Strategy

### Cache Layers

| Cache | TTL | Invalidation | Hit Target |
|-------|-----|--------------|------------|
| Folder listing | 5 min | On file/folder create/delete/move | 90% |
| File metadata | 10 min | On file update/delete | 85% |
| User quota | 1 min | On upload complete | 95% |

### Cache-Aside Pattern

```typescript
async function getFolderListing(folderId: string): Promise<FolderContents> {
  const cacheKey = `cache:folder:${folderId}:listing`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss: query database
  const contents = await db.query(`
    SELECT * FROM files WHERE folder_id = $1 AND deleted_at IS NULL
    UNION ALL
    SELECT * FROM folders WHERE parent_id = $1 AND deleted_at IS NULL
  `, [folderId]);

  // Write to cache
  await redis.setex(cacheKey, 300, JSON.stringify(contents));

  return contents;
}

// Invalidation on write
async function createFile(file: FileInput): Promise<File> {
  const created = await db.insert('files', file);
  await redis.del(`cache:folder:${file.folder_id}:listing`);
  return created;
}
```

## Message Queue Design

### RabbitMQ Topology

```
Exchange: sync.events (topic)
  |
  +-- Queue: sync.notifications (routing: user.*.change)
  |     Consumer: WebSocket broadcaster
  |
  +-- Queue: background.jobs (routing: job.*)
        Consumers: 2-3 workers

Exchange: uploads (direct)
  |
  +-- Queue: upload.cleanup (routing: cleanup)
        Consumer: Expired upload cleaner

Dead Letter Exchange: dlx
  +-- Queue: failed.jobs
```

### Message Types

```typescript
// Sync notification
{
  type: "file_changed",
  userId: "uuid",
  fileId: "uuid",
  action: "created" | "updated" | "deleted" | "moved",
  timestamp: "2024-01-15T10:30:00Z"
}

// Background job
{
  type: "garbage_collect_chunks",
  chunkHashes: ["abc123...", "def456..."],
  scheduledAt: "2024-01-15T10:30:00Z"
}
```

### Delivery Guarantees

- **Sync notifications:** At-least-once. Clients handle duplicate events (idempotent UI updates).
- **Background jobs:** At-least-once with manual ack. Failed jobs go to DLX for retry.
- **Retry policy:** 3 attempts with exponential backoff (1s, 5s, 25s), then DLX.

## Security Considerations

### Authentication and Authorization

| Mechanism | Implementation |
|-----------|----------------|
| **Session auth** | express-session with Redis store, httpOnly cookies |
| **Password hashing** | bcrypt with cost factor 12 |
| **RBAC** | Two roles: `user` (own files), `admin` (all users, system stats) |
| **Rate limiting** | 100 req/min per user, 20 req/min per IP for auth endpoints |

### Authorization Rules

```typescript
// Middleware pattern
const requireOwnership = async (req, res, next) => {
  const file = await db.getFile(req.params.fileId);

  if (!file) return res.status(404).json({ error: 'Not found' });

  // Owner has full access
  if (file.owner_id === req.user.id) return next();

  // Check folder share permissions
  const share = await db.getFolderShare(file.folder_id, req.user.id);
  if (share) {
    req.permission = share.permission; // 'read' or 'write'
    return next();
  }

  return res.status(403).json({ error: 'Access denied' });
};

// Admin-only routes
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};
```

### Data Protection

| Concern | Mitigation |
|---------|------------|
| **Chunk access** | Presigned URLs with 15-min expiry for downloads |
| **Share links** | Optional password (bcrypt), expiration, download limits |
| **Upload validation** | Verify chunk hash matches on server |
| **Input sanitization** | Filename sanitization, path traversal prevention |
| **HTTPS** | Required in production (nginx TLS termination) |

## Observability

### Metrics (Prometheus)

```yaml
# Application metrics
- http_requests_total{method, path, status}
- http_request_duration_seconds{method, path}
- upload_chunks_total{status}  # success, duplicate, failed
- upload_sessions_active
- file_downloads_total
- storage_bytes_used{user_id}

# Business metrics
- deduplication_ratio  # (total_logical_size - actual_stored) / total_logical_size
- sync_latency_seconds{percentile}
- active_websocket_connections

# Infrastructure
- postgresql_connections_active
- redis_memory_used_bytes
- rabbitmq_queue_depth{queue}
- minio_bucket_size_bytes
```

### Logging Structure

```json
{
  "timestamp": "2024-01-15T10:30:00.123Z",
  "level": "info",
  "service": "api-server",
  "traceId": "abc123",
  "userId": "550e8400-...",
  "message": "File upload completed",
  "fileId": "660e8400-...",
  "sizeBytes": 15728640,
  "chunksUploaded": 2,
  "chunksDeduped": 2,
  "durationMs": 3420
}
```

### Alerting Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| API error rate (5xx) | > 1% | > 5% | Check logs, rollback if recent deploy |
| Upload success rate | < 98% | < 95% | Check MinIO connectivity |
| Sync latency p95 | > 5s | > 15s | Scale WebSocket servers |
| Queue depth | > 1000 | > 5000 | Scale workers, check for stuck jobs |
| Storage used | > 80% | > 95% | Add storage, notify admin |

### Distributed Tracing

Use OpenTelemetry with trace context propagation:

```typescript
// Trace ID flows through: API -> PostgreSQL -> MinIO -> RabbitMQ
const tracer = trace.getTracer('dropbox-api');

async function handleUploadChunk(req, res) {
  const span = tracer.startSpan('upload_chunk', {
    attributes: {
      'upload.id': req.params.uploadId,
      'chunk.index': req.params.index,
      'chunk.size': req.body.length
    }
  });

  try {
    // ... upload logic
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    throw error;
  } finally {
    span.end();
  }
}
```

## Failure Handling

### Retry Strategies

| Operation | Retry | Backoff | Idempotency |
|-----------|-------|---------|-------------|
| Chunk upload to MinIO | 3 attempts | Exponential (1s, 2s, 4s) | Safe: PUT is idempotent |
| Metadata write | 2 attempts | Fixed 500ms | Use transaction, rollback on fail |
| Sync notification | 3 attempts | Exponential | Clients dedupe by eventId |
| Download stream | 0 (client resumes) | N/A | Range requests for resume |

### Circuit Breaker Pattern

```typescript
const circuitBreaker = new CircuitBreaker({
  failureThreshold: 5,      // Open after 5 failures
  successThreshold: 2,      // Close after 2 successes
  timeout: 30000,           // Reset after 30s open
});

async function uploadToMinIO(chunkData: Buffer, hash: string) {
  return circuitBreaker.execute(async () => {
    await minioClient.putObject('chunks', hash, chunkData);
  });
}

// When circuit is open, fail fast instead of waiting for MinIO timeout
circuitBreaker.on('open', () => {
  logger.error('MinIO circuit breaker opened - storage unavailable');
  // Alert on-call, reject uploads with 503
});
```

### Disaster Recovery (Local Dev Scope)

| Component | Backup Strategy | Recovery |
|-----------|-----------------|----------|
| PostgreSQL | `pg_dump` daily to local file | `pg_restore` from dump |
| MinIO | Cross-bucket replication (if 2+ instances) | Restore from replica |
| Redis | RDB snapshots every 15 min | Restart loads from RDB |
| RabbitMQ | Durable queues, persistent messages | Survives restart |

### Failure Scenarios and Responses

| Scenario | Detection | Response |
|----------|-----------|----------|
| MinIO down | Circuit breaker opens | Reject uploads with 503, downloads fail gracefully |
| PostgreSQL down | Connection pool errors | All API requests fail, alert immediately |
| Redis down | Session middleware errors | Users logged out, cache cold, operations continue |
| Worker crash | Heartbeat timeout | Kubernetes/PM2 restarts, unacked messages requeued |
| Upload interrupted | Client reconnects | Resume from last confirmed chunk |

## Cost Tradeoffs (Local Dev Context)

| Decision | Lower Cost Option | Higher Performance Option | Our Choice |
|----------|-------------------|---------------------------|------------|
| Chunk storage | Local filesystem | MinIO cluster | MinIO single instance |
| Database | SQLite | PostgreSQL cluster | PostgreSQL single instance |
| Cache | In-memory (node-cache) | Redis cluster | Redis single instance |
| Queue | Bull (Redis-based) | RabbitMQ cluster | RabbitMQ single instance |
| Deduplication | None | Content-defined chunking | Fixed-size (simpler) |

### Resource Estimates (Docker Compose)

| Service | Memory | CPU | Disk |
|---------|--------|-----|------|
| PostgreSQL | 512 MB | 0.5 | 1 GB |
| MinIO | 512 MB | 0.5 | 100 GB |
| Redis | 256 MB | 0.25 | 100 MB |
| RabbitMQ | 256 MB | 0.25 | 100 MB |
| API Server (x3) | 1.5 GB | 1.5 | - |
| nginx | 64 MB | 0.1 | - |
| **Total** | ~3 GB | ~3 cores | ~102 GB |

## Scalability Considerations

### Horizontal Scaling Points

| Component | Scaling Trigger | Approach |
|-----------|-----------------|----------|
| API Servers | CPU > 70% or RPS > 100/server | Add instances behind LB |
| Sync Workers | Queue depth > 1000 | Add worker processes |
| PostgreSQL | Connections > 80% of max | Read replicas (future) |
| MinIO | Storage > 80% | Add nodes to cluster (future) |

### Database Scaling Path

1. **Current:** Single PostgreSQL instance
2. **Step 1:** Read replicas for folder listings, file searches
3. **Step 2:** Partition `chunks` table by hash prefix (sharding)
4. **Step 3:** Separate metadata per user (tenant isolation)

### Future Optimizations

1. **Delta sync:** Only upload changed chunks using content-defined chunking (Rabin fingerprinting)
2. **Edge caching:** CDN for popular shared files
3. **Compression:** Compress chunks before storage (LZ4 for speed)
4. **Encryption:** Client-side encryption with user-held keys
5. **Smart sync:** Prioritize recently accessed files, lazy-load old files

## Trade-offs and Alternatives

### Considered Alternatives

| Decision | Alternative | Why Not Chosen |
|----------|-------------|----------------|
| PostgreSQL metadata | CouchDB | Need strong consistency for file operations |
| MinIO chunks | Filesystem | Doesn't scale, no built-in replication |
| Fixed chunk size | Rabin fingerprinting | Complexity; fixed is fine for MVP |
| WebSocket sync | Polling | Higher latency, more server load |
| RabbitMQ | Kafka | Overkill for this scale, more complex |
| Redis sessions | JWT | Sessions simpler for logout, quota tracking |

### Technical Debt Acknowledged

1. **No client-side encryption:** Files stored in plaintext in MinIO
2. **Single PostgreSQL:** No read replicas, single point of failure
3. **Basic conflict resolution:** No OT/CRDT for real-time collaboration
4. **Fixed chunk boundaries:** Suboptimal for small edits in large files

## Monitoring and Observability

### Grafana Dashboards

**Dashboard 1: System Overview**
- Request rate and error rate
- Active users and WebSocket connections
- Storage usage trend
- Upload/download throughput

**Dashboard 2: Storage Deep Dive**
- Deduplication ratio over time
- Chunk distribution by size
- MinIO latency percentiles
- Garbage collection metrics

**Dashboard 3: User Activity**
- Files uploaded/downloaded per hour
- Active upload sessions
- Share link usage
- Storage quota utilization

### Health Check Endpoints

```
GET /health/live    -> 200 if process running
GET /health/ready   -> 200 if DB + Redis + MinIO connected
GET /health/deep    -> JSON with component status + latencies
```

```json
// GET /health/deep response
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "components": {
    "postgresql": { "status": "up", "latencyMs": 2 },
    "redis": { "status": "up", "latencyMs": 1 },
    "minio": { "status": "up", "latencyMs": 5 },
    "rabbitmq": { "status": "up", "latencyMs": 3 }
  },
  "metrics": {
    "activeConnections": 45,
    "queueDepth": 12,
    "cacheHitRate": 0.87
  }
}
```
