# iCloud Sync - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement (1 minute)

"I'll design iCloud, a file and photo synchronization service that keeps data consistent across all Apple devices. As a backend engineer, I'll focus on the core sync infrastructure: version vectors for conflict detection, chunk-based storage with deduplication, and reliable sync protocols that handle network failures gracefully.

The key backend challenges are: implementing causality tracking across distributed devices, designing content-addressed chunk storage for efficient delta sync, and building an idempotent sync API that handles offline-first clients reconnecting with pending changes."

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
- **Storage**: Handle petabytes of user data globally
- **Privacy**: End-to-end encryption for sensitive data categories

### Scale Estimates
- **Users**: 1 billion+ Apple IDs
- **Devices per user**: 3-5 average
- **Storage per user**: 50GB average (5GB free tier up to 2TB paid)
- **Sync events**: Billions per day globally

### Key Questions I'd Ask
1. Should we prioritize latency or bandwidth efficiency for sync?
2. What conflict resolution strategy do users prefer (keep both vs. auto-merge)?
3. Which data categories require end-to-end encryption?

## High-Level Architecture (5 minutes)

```
+-------------------------------------------------------------+
|                     Client Layer                             |
|          iPhone | iPad | Mac | Apple Watch | Web             |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|                    API Gateway                               |
|              (Auth, Rate Limiting, Routing)                  |
+-------------------------------------------------------------+
        |                     |                     |
        v                     v                     v
+---------------+    +---------------+    +---------------+
|  Sync Service |    | Photo Service |    | CloudKit      |
|               |    |               |    |               |
| - File sync   |    | - Library     |    | - App data    |
| - Conflict    |    | - Analysis    |    | - Key-value   |
| - Versions    |    | - Sharing     |    | - Database    |
+---------------+    +---------------+    +---------------+
        |                     |                     |
        v                     v                     v
+-------------------------------------------------------------+
|                      Data Layer                              |
+-----------------+-------------------+-----------------------+
|   PostgreSQL    |   Object Storage  |      Cassandra        |
|   - Metadata    |   - File chunks   |      - Sync state     |
|   - Users       |   - Photos        |      - Version vectors|
+-----------------+-------------------+-----------------------+
```

### Core Components

1. **Sync Service**: Manages file metadata, detects changes, and coordinates sync
2. **Photo Service**: Handles photo library with derivative generation and smart storage
3. **CloudKit**: Provides app-level data sync with key-value and structured storage
4. **Object Storage (MinIO)**: Content-addressed chunk storage with deduplication
5. **Cassandra**: High-availability sync state and version vector storage

## Deep Dive: Version Vectors and Conflict Detection (10 minutes)

This is the heart of the sync system. We need to detect when the same file was modified on multiple devices before syncing.

### Version Vector Approach

Each file has a version vector: `{deviceId: sequenceNumber}`. When a device edits a file, it increments its own sequence number.

```javascript
class SyncEngine {
  compareVersions(localVersion, serverVersion) {
    // Version vectors: { deviceId: sequenceNumber }
    let localNewer = false;
    let serverNewer = false;

    const allDevices = new Set([
      ...Object.keys(localVersion),
      ...Object.keys(serverVersion)
    ]);

    for (const device of allDevices) {
      const localSeq = localVersion[device] || 0;
      const serverSeq = serverVersion[device] || 0;

      if (localSeq > serverSeq) localNewer = true;
      if (serverSeq > localSeq) serverNewer = true;
    }

    if (localNewer && serverNewer) return 'conflict';
    if (localNewer) return 'local-newer';
    if (serverNewer) return 'server-newer';
    return 'equal';
  }

  async reconcile(localChanges, serverState) {
    const toUpload = [];
    const toDownload = [];
    const conflicts = [];

    const allFileIds = new Set([
      ...localChanges.keys(),
      ...serverState.keys()
    ]);

    for (const fileId of allFileIds) {
      const local = localChanges.get(fileId);
      const server = serverState.get(fileId);

      if (!server) {
        toUpload.push(local);
      } else if (!local) {
        toDownload.push(server);
      } else {
        const comparison = this.compareVersions(local.version, server.version);

        if (comparison === 'local-newer') {
          toUpload.push(local);
        } else if (comparison === 'server-newer') {
          toDownload.push(server);
        } else if (comparison === 'conflict') {
          conflicts.push({ fileId, local, server });
        }
      }
    }

    return { toUpload, toDownload, conflicts };
  }
}
```

### Conflict Scenarios

**No Conflict**: Versions form a linear chain (one device's edits happened after the other)
- Local: `{A: 3, B: 2}`, Server: `{A: 2, B: 2}` -> Local wins

**Conflict**: Both devices edited independently
- Local: `{A: 3, B: 2}`, Server: `{A: 2, B: 3}` -> Conflict!

### Why Version Vectors over Timestamps?

| Approach | Pros | Cons |
|----------|------|------|
| Timestamps | Simple | Clock drift, no causality |
| Version Vectors | Detects true conflicts | More complex |
| Lamport Clocks | Ordered events | No concurrency detection |

Version vectors tell us not just which is newer, but whether edits were concurrent (conflict) or sequential (no conflict).

### Conflict Resolution Service

```javascript
class ConflictResolver {
  async resolveConflict(conflict) {
    const { fileId, local, server } = conflict;
    const fileType = this.getFileType(fileId);

    switch (fileType) {
      case 'text':
        return this.mergeTextFiles(local, server);

      case 'photo':
        return this.keepBoth(local, server);

      case 'document':
        return this.lastWriteWinsWithCopy(local, server);

      default:
        return this.promptUser(local, server);
    }
  }

  async mergeTextFiles(local, server) {
    const ancestor = await this.getCommonAncestor(local, server);
    const merged = diff3Merge(
      await this.getContent(local),
      await this.getContent(ancestor),
      await this.getContent(server)
    );

    if (!merged.hasConflicts) {
      return { type: 'merged', content: merged.result };
    }
    return this.keepBoth(local, server);
  }

  generateConflictName(file) {
    const ext = path.extname(file.name);
    const base = path.basename(file.name, ext);
    const timestamp = new Date().toISOString().split('T')[0];
    const device = file.lastModifiedDevice;
    return `${base} (${device}'s conflicted copy ${timestamp})${ext}`;
  }
}
```

## Deep Dive: Chunk-Based File Storage (8 minutes)

Large files need efficient transfer. We split files into content-addressed chunks.

### Chunked Upload with Deduplication

```javascript
class ChunkedUploader {
  constructor(chunkSize = 4 * 1024 * 1024) {
    this.chunkSize = chunkSize;
  }

  async uploadFile(fileId, filePath) {
    const fileSize = (await fs.stat(filePath)).size;

    // Get existing chunks on server (for delta sync)
    const existingChunks = await this.getServerChunks(fileId);
    const existingHashes = new Set(existingChunks.map(c => c.hash));

    const chunks = [];
    const stream = fs.createReadStream(filePath, {
      highWaterMark: this.chunkSize
    });

    let chunkIndex = 0;
    for await (const data of stream) {
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      chunks.push({ index: chunkIndex, hash, size: data.length });

      // Only upload if chunk doesn't exist (deduplication)
      if (!existingHashes.has(hash)) {
        await this.uploadChunk(hash, data);
      }

      chunkIndex++;
    }

    await this.updateFileManifest(fileId, { chunks, totalSize: fileSize });
    return chunks;
  }

  async uploadChunk(hash, data) {
    // Encrypt chunk before upload
    const encrypted = await this.encrypt(data);

    await minioClient.putObject('icloud-chunks', `chunks/${hash}`, encrypted);

    // Update reference count
    await db.query(`
      INSERT INTO chunk_store (hash, size, reference_count, storage_key)
      VALUES ($1, $2, 1, $3)
      ON CONFLICT (hash) DO UPDATE SET reference_count = chunk_store.reference_count + 1
    `, [hash, data.length, `chunks/${hash}`]);
  }
}
```

### Chunk Reference Counting Schema

```sql
CREATE TABLE chunk_store (
  hash VARCHAR(64) PRIMARY KEY,
  size INTEGER NOT NULL,
  reference_count INTEGER DEFAULT 1,
  storage_key VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- When a file is deleted, decrement refs; cleanup when 0
CREATE TABLE file_chunks (
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_hash VARCHAR(64) REFERENCES chunk_store(hash),
  chunk_size INTEGER NOT NULL,
  PRIMARY KEY (file_id, chunk_index)
);
```

### Benefits of Chunking

1. **Deduplication**: Same chunk across files stored once
2. **Delta Sync**: Only upload changed chunks
3. **Resumable**: Interrupted uploads continue from last chunk
4. **Parallel**: Upload/download multiple chunks simultaneously

## Deep Dive: Idempotent Sync Operations (6 minutes)

Sync operations are vulnerable to duplicate processing when clients retry.

### Idempotency Service

```javascript
class IdempotentUploader {
  constructor(redis, storage, db) {
    this.redis = redis;
    this.storage = storage;
    this.db = db;
  }

  async uploadFile(idempotencyKey, fileId, fileData, userId) {
    const lockKey = `upload:lock:${idempotencyKey}`;
    const resultKey = `upload:result:${idempotencyKey}`;

    // Check if this request was already processed
    const existingResult = await this.redis.get(resultKey);
    if (existingResult) {
      return JSON.parse(existingResult);
    }

    // Acquire lock to prevent duplicate processing
    const lockAcquired = await this.redis.set(
      lockKey, 'locked', 'NX', 'EX', 300
    );

    if (!lockAcquired) {
      await this.waitForResult(resultKey);
      return JSON.parse(await this.redis.get(resultKey));
    }

    try {
      const result = await this.performUpload(fileId, fileData, userId);
      await this.redis.setex(resultKey, 86400, JSON.stringify(result));
      return result;
    } finally {
      await this.redis.del(lockKey);
    }
  }
}
```

### Client-Side Retry with Exponential Backoff

```javascript
class RetryClient {
  constructor(maxRetries = 3, baseDelayMs = 1000) {
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
  }

  async uploadWithRetry(fileId, fileData) {
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(fileId + fileData.slice(0, 1024))
      .digest('hex');

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch('/api/v1/files/upload', {
          method: 'POST',
          headers: {
            'Idempotency-Key': idempotencyKey,
            'Content-Type': 'application/octet-stream'
          },
          body: fileData
        });

        if (response.ok) return await response.json();
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`Client error: ${response.status}`);
        }
        lastError = new Error(`Server error: ${response.status}`);
      } catch (error) {
        lastError = error;
      }

      if (attempt < this.maxRetries) {
        const delay = this.baseDelayMs * Math.pow(2, attempt);
        const jitter = delay * 0.2 * Math.random();
        await new Promise(r => setTimeout(r, delay + jitter));
      }
    }
    throw lastError;
  }
}
```

## Deep Dive: Circuit Breaker for Storage (5 minutes)

MinIO/S3 failures can cascade to the entire sync service.

```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeoutMs = options.resetTimeoutMs || 30000;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls || 3;

    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = null;
  }

  async execute(fn) {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.halfOpenMaxCalls) {
        this.state = 'closed';
        this.failureCount = 0;
      }
    } else {
      this.failureCount = 0;
    }
  }

  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
    }
  }
}

// Separate breakers for different operations
const circuitBreakers = {
  storage_put: new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30000 }),
  storage_get: new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 15000 }),
  storage_stat: new CircuitBreaker({ failureThreshold: 10, resetTimeoutMs: 5000 })
};
```

## Database Schema (3 minutes)

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY,
  apple_id VARCHAR(200) UNIQUE NOT NULL,
  storage_quota BIGINT DEFAULT 5368709120,
  storage_used BIGINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Files
CREATE TABLE files (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  name VARCHAR(500) NOT NULL,
  path VARCHAR(1000) NOT NULL,
  size BIGINT NOT NULL,
  content_hash VARCHAR(64),
  version JSONB,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  modified_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_files_user_path ON files(user_id, path);

-- Sync State (per device)
CREATE TABLE device_sync_state (
  device_id UUID,
  user_id UUID REFERENCES users(id),
  last_sync_token VARCHAR(100),
  sync_cursor JSONB,
  last_sync_at TIMESTAMP,
  PRIMARY KEY (device_id, user_id)
);

-- Photos
CREATE TABLE photos (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  hash VARCHAR(64) NOT NULL,
  taken_at TIMESTAMP,
  location GEOGRAPHY(Point),
  full_res_size BIGINT,
  metadata JSONB,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_photos_user_date ON photos(user_id, taken_at DESC);

-- Audit Log
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  user_id UUID,
  device_id UUID,
  resource_type VARCHAR(50),
  resource_id UUID,
  action VARCHAR(100) NOT NULL,
  metadata JSONB,
  ip_address INET,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_user_time ON audit_log(user_id, created_at DESC);
```

## Trade-offs and Alternatives (5 minutes)

### 1. Version Vectors vs. Operational Transform

| Aspect | Version Vectors | Operational Transform |
|--------|-----------------|----------------------|
| Complexity | Moderate | High |
| Conflict detection | Excellent | Built-in merge |
| File types | Any | Text/structured only |
| Implementation | Simpler | Complex transforms |

**Chose Version Vectors**: Simpler, works for any file type. OT would be better for collaborative text editing.

### 2. Fixed vs. Content-Defined Chunking

| Aspect | Fixed 4MB Chunks | Content-Defined (CDC) |
|--------|------------------|----------------------|
| Implementation | Simple | Complex (Rabin fingerprinting) |
| Delta efficiency | Poor for insertions | Excellent |
| Predictability | High | Variable chunk sizes |

**Chose Fixed initially**: Simple, predictable. Would implement CDC as optimization for frequently-edited files.

### 3. Cassandra vs. PostgreSQL for Sync State

| Aspect | Cassandra | PostgreSQL |
|--------|-----------|------------|
| Availability | AP (partition tolerant) | CP (consistent) |
| Write scale | Excellent | Good with sharding |
| Complexity | Higher | Lower |

**Chose hybrid**: Cassandra for sync state (high-availability needed), PostgreSQL for file metadata (ACID needed).

### 4. Push vs. Pull Sync

**Chose Hybrid**:
- Push: WebSocket notification when changes occur
- Pull: Periodic full sync as fallback
- Rationale: Low latency with eventual consistency guarantee

### Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Sync model | Version vectors | Timestamps | Conflict detection |
| Storage | Chunked, content-addressed | Whole file | Deduplication, delta |
| Encryption | Per-file keys | Single user key | Key rotation, sharing |
| State storage | Cassandra | PostgreSQL | High availability |

## Observability (3 minutes)

### Prometheus Metrics

```javascript
const syncDuration = new Histogram({
  name: 'icloud_sync_duration_seconds',
  help: 'Duration of sync operations',
  labelNames: ['device_type', 'result'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30]
});

const conflictsDetected = new Counter({
  name: 'icloud_conflicts_total',
  help: 'Total number of sync conflicts detected',
  labelNames: ['file_type', 'resolution']
});

const chunkDedup = new Counter({
  name: 'icloud_dedup_hits_total',
  help: 'Chunks skipped due to deduplication'
});
```

### Key SLIs

| Metric | Query | SLO |
|--------|-------|-----|
| Sync Success Rate | `rate(icloud_sync_total{result="success"}[5m]) / rate(icloud_sync_total[5m])` | 99.9% |
| P95 Sync Latency | `histogram_quantile(0.95, rate(icloud_sync_duration_seconds_bucket[5m]))` | < 5s |
| Conflict Rate | `rate(icloud_conflicts_total[1h])` | < 0.1% |
| Dedup Ratio | `rate(icloud_dedup_hits_total[1h]) / rate(icloud_chunks_processed[1h])` | > 30% |

## Closing Summary (1 minute)

"The iCloud sync backend is built around three core innovations:

1. **Version Vectors** for conflict detection - enabling us to distinguish true concurrent edits from sequential changes without relying on synchronized clocks
2. **Content-addressed chunk storage** for efficiency - achieving deduplication across files and delta sync with reference counting for cleanup
3. **Idempotent sync operations** with circuit breakers - ensuring reliability when clients retry after failures

The key trade-off throughout is complexity vs. capability. We chose version vectors over simple timestamps because detecting true conflicts is essential for user trust. We chose chunk-based storage because the bandwidth savings at scale are massive.

For future improvements, I'd prioritize content-defined chunking for better delta efficiency and add compression before upload. The observability layer with Prometheus metrics and structured logging enables quick diagnosis of sync issues at scale."
