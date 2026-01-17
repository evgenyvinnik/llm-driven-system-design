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

1. **Sync**: Synchronize files across devices
2. **Photos**: Store and sync photo library
3. **Conflict**: Detect and resolve conflicts
4. **Offline**: Work offline, sync when connected
5. **Share**: Share files and albums

### Non-Functional Requirements

- **Consistency**: Eventual consistency with conflict detection
- **Latency**: < 5 seconds for sync propagation
- **Storage**: Petabytes of user data
- **Privacy**: End-to-end encryption for sensitive data

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│          iPhone │ iPad │ Mac │ Apple Watch │ Web                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│              (Auth, Rate Limiting, Routing)                     │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Sync Service │    │ Photo Service │    │ CloudKit      │
│               │    │               │    │               │
│ - File sync   │    │ - Library     │    │ - App data    │
│ - Conflict    │    │ - Analysis    │    │ - Key-value   │
│ - Versions    │    │ - Sharing     │    │ - Database    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │   Object Storage  │      Cassandra            │
│   - Metadata    │   - File chunks   │      - Sync state         │
│   - Users       │   - Photos        │      - Version vectors    │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Sync Protocol

**Version Vectors for Conflict Detection:**
```javascript
class SyncEngine {
  constructor(deviceId) {
    this.deviceId = deviceId
    this.localState = new Map() // fileId -> { version, hash, modTime }
  }

  async sync() {
    // 1. Get local changes since last sync
    const localChanges = await this.getLocalChanges()

    // 2. Get server changes
    const serverState = await this.fetchServerState()

    // 3. Detect conflicts
    const { toUpload, toDownload, conflicts } = this.reconcile(
      localChanges,
      serverState
    )

    // 4. Handle conflicts
    for (const conflict of conflicts) {
      await this.resolveConflict(conflict)
    }

    // 5. Upload local changes
    for (const file of toUpload) {
      await this.uploadFile(file)
    }

    // 6. Download server changes
    for (const file of toDownload) {
      await this.downloadFile(file)
    }

    // 7. Update sync state
    await this.updateSyncState()
  }

  reconcile(localChanges, serverState) {
    const toUpload = []
    const toDownload = []
    const conflicts = []

    // Process all known files
    const allFileIds = new Set([
      ...localChanges.keys(),
      ...serverState.keys()
    ])

    for (const fileId of allFileIds) {
      const local = localChanges.get(fileId)
      const server = serverState.get(fileId)

      if (!server) {
        // New local file, upload it
        toUpload.push(local)
      } else if (!local) {
        // New server file, download it
        toDownload.push(server)
      } else {
        // Both exist, check versions
        const comparison = this.compareVersions(local.version, server.version)

        if (comparison === 'local-newer') {
          toUpload.push(local)
        } else if (comparison === 'server-newer') {
          toDownload.push(server)
        } else if (comparison === 'conflict') {
          conflicts.push({ fileId, local, server })
        }
        // If equal, no action needed
      }
    }

    return { toUpload, toDownload, conflicts }
  }

  compareVersions(localVersion, serverVersion) {
    // Version vectors: { deviceId: sequenceNumber }
    let localNewer = false
    let serverNewer = false

    const allDevices = new Set([
      ...Object.keys(localVersion),
      ...Object.keys(serverVersion)
    ])

    for (const device of allDevices) {
      const localSeq = localVersion[device] || 0
      const serverSeq = serverVersion[device] || 0

      if (localSeq > serverSeq) localNewer = true
      if (serverSeq > localSeq) serverNewer = true
    }

    if (localNewer && serverNewer) return 'conflict'
    if (localNewer) return 'local-newer'
    if (serverNewer) return 'server-newer'
    return 'equal'
  }
}
```

### 2. Chunk-Based File Transfer

**Efficient Delta Sync:**
```javascript
class ChunkedUploader {
  constructor(chunkSize = 4 * 1024 * 1024) { // 4MB chunks
    this.chunkSize = chunkSize
  }

  async uploadFile(fileId, filePath) {
    const fileSize = await fs.stat(filePath).size
    const totalChunks = Math.ceil(fileSize / this.chunkSize)

    // Get existing chunks on server
    const existingChunks = await this.getServerChunks(fileId)
    const existingHashes = new Set(existingChunks.map(c => c.hash))

    const chunks = []
    const stream = fs.createReadStream(filePath, {
      highWaterMark: this.chunkSize
    })

    let chunkIndex = 0
    for await (const data of stream) {
      const hash = crypto.createHash('sha256').update(data).digest('hex')

      chunks.push({
        index: chunkIndex,
        hash,
        size: data.length
      })

      // Only upload if chunk doesn't exist (deduplication)
      if (!existingHashes.has(hash)) {
        await this.uploadChunk(hash, data)
      }

      chunkIndex++
    }

    // Update file manifest
    await this.updateFileManifest(fileId, {
      chunks,
      totalSize: fileSize,
      version: this.incrementVersion(fileId)
    })

    return chunks
  }

  async downloadFile(fileId, destPath) {
    const manifest = await this.getFileManifest(fileId)

    const writeStream = fs.createWriteStream(destPath)

    for (const chunk of manifest.chunks) {
      const data = await this.downloadChunk(chunk.hash)

      // Verify chunk integrity
      const actualHash = crypto.createHash('sha256').update(data).digest('hex')
      if (actualHash !== chunk.hash) {
        throw new Error(`Chunk integrity check failed for ${chunk.hash}`)
      }

      writeStream.write(data)
    }

    writeStream.end()
  }

  async uploadChunk(hash, data) {
    // Encrypt chunk before upload
    const encrypted = await this.encrypt(data)

    await s3.upload({
      Bucket: 'icloud-chunks',
      Key: `chunks/${hash}`,
      Body: encrypted,
      ContentType: 'application/octet-stream'
    }).promise()
  }
}
```

### 3. Conflict Resolution

**Automatic and Manual Resolution:**
```javascript
class ConflictResolver {
  async resolveConflict(conflict) {
    const { fileId, local, server } = conflict

    // Try automatic resolution based on file type
    const fileType = this.getFileType(fileId)

    switch (fileType) {
      case 'text':
        return this.mergeTextFiles(local, server)

      case 'photo':
        // Photos: keep both as separate files
        return this.keepBoth(local, server)

      case 'document':
        // Documents: use last-modified wins, keep other as conflict copy
        return this.lastWriteWins(local, server)

      default:
        // Unknown type: ask user
        return this.promptUser(local, server)
    }
  }

  async mergeTextFiles(local, server) {
    // Three-way merge using common ancestor
    const ancestor = await this.getCommonAncestor(local, server)

    const localContent = await this.getContent(local)
    const serverContent = await this.getContent(server)
    const ancestorContent = await this.getContent(ancestor)

    try {
      const merged = diff3Merge(localContent, ancestorContent, serverContent)

      if (!merged.hasConflicts) {
        // Clean merge
        return {
          type: 'merged',
          content: merged.result
        }
      } else {
        // Has conflicts, create conflict file
        return {
          type: 'manual',
          conflictFile: this.createConflictFile(local, server, merged)
        }
      }
    } catch (e) {
      return this.keepBoth(local, server)
    }
  }

  async keepBoth(local, server) {
    // Rename server version with conflict suffix
    const conflictName = this.generateConflictName(server)

    return {
      type: 'kept-both',
      localFile: local,
      conflictCopy: {
        ...server,
        name: conflictName
      }
    }
  }

  generateConflictName(file) {
    const ext = path.extname(file.name)
    const base = path.basename(file.name, ext)
    const timestamp = new Date().toISOString().split('T')[0]
    const device = file.lastModifiedDevice

    return `${base} (${device}'s conflicted copy ${timestamp})${ext}`
  }
}
```

### 4. Photo Library Sync

**Optimized Photo Storage:**
```javascript
class PhotoLibrary {
  async syncPhoto(photo) {
    // Upload full resolution to cloud
    const fullResHash = await this.uploadOriginal(photo)

    // Generate derivatives
    const derivatives = await this.generateDerivatives(photo)

    // Store metadata
    await db.query(`
      INSERT INTO photos (id, user_id, hash, taken_at, location, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [photo.id, photo.userId, fullResHash, photo.takenAt,
        photo.location, photo.exifData])

    // Upload derivatives
    for (const [size, derivative] of Object.entries(derivatives)) {
      await this.uploadDerivative(photo.id, size, derivative)
    }

    return { photoId: photo.id, hash: fullResHash }
  }

  async generateDerivatives(photo) {
    return {
      thumbnail: await this.resize(photo, 200, 200),
      preview: await this.resize(photo, 1024, 1024),
      display: await this.resize(photo, 2048, 2048)
    }
  }

  // Optimize device storage
  async optimizeDeviceStorage(deviceId, targetFreeSpace) {
    // Get photos on device sorted by last viewed
    const photos = await db.query(`
      SELECT p.*, dp.last_viewed
      FROM photos p
      JOIN device_photos dp ON p.id = dp.photo_id
      WHERE dp.device_id = $1
      AND dp.has_full_res = true
      ORDER BY dp.last_viewed ASC
    `, [deviceId])

    let freedSpace = 0
    const toOptimize = []

    for (const photo of photos.rows) {
      if (freedSpace >= targetFreeSpace) break

      // Keep full-res in cloud, replace with preview on device
      toOptimize.push(photo.id)
      freedSpace += photo.full_res_size - photo.preview_size
    }

    return { photosToOptimize: toOptimize, estimatedFreedSpace: freedSpace }
  }

  async downloadFullResolution(photoId) {
    const photo = await this.getPhotoMeta(photoId)
    const originalData = await this.downloadOriginal(photo.hash)

    // Mark that this device now has full-res
    await db.query(`
      UPDATE device_photos
      SET has_full_res = true, last_viewed = NOW()
      WHERE photo_id = $1 AND device_id = $2
    `, [photoId, this.deviceId])

    return originalData
  }
}
```

### 5. End-to-End Encryption

**Secure Key Management:**
```javascript
class EncryptionService {
  constructor() {
    this.algorithm = 'aes-256-gcm'
  }

  async encryptFile(fileData, userId) {
    // Get or create per-file key
    const fileKey = crypto.randomBytes(32)

    // Encrypt file data
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(this.algorithm, fileKey, iv)

    const encrypted = Buffer.concat([
      cipher.update(fileData),
      cipher.final()
    ])

    const authTag = cipher.getAuthTag()

    // Wrap file key with user's master key
    const masterKey = await this.getUserMasterKey(userId)
    const wrappedKey = await this.wrapKey(fileKey, masterKey)

    return {
      encryptedData: encrypted,
      iv,
      authTag,
      wrappedKey
    }
  }

  async decryptFile(encryptedData, iv, authTag, wrappedKey, userId) {
    // Unwrap file key
    const masterKey = await this.getUserMasterKey(userId)
    const fileKey = await this.unwrapKey(wrappedKey, masterKey)

    // Decrypt file
    const decipher = crypto.createDecipheriv(this.algorithm, fileKey, iv)
    decipher.setAuthTag(authTag)

    return Buffer.concat([
      decipher.update(encryptedData),
      decipher.final()
    ])
  }

  async getUserMasterKey(userId) {
    // Master key derived from user's password
    // Stored in device's secure enclave/keychain
    const keyData = await keychain.get(`icloud_master_${userId}`)
    return Buffer.from(keyData, 'hex')
  }

  async wrapKey(key, wrapperKey) {
    // AES-KW (Key Wrap)
    const wrapped = crypto.createCipheriv('aes-256-wrap', wrapperKey, null)
    return Buffer.concat([wrapped.update(key), wrapped.final()])
  }
}
```

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY,
  apple_id VARCHAR(200) UNIQUE NOT NULL,
  storage_quota BIGINT DEFAULT 5368709120, -- 5GB
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
  version JSONB, -- Version vector
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  modified_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_files_user_path ON files(user_id, path);

-- File Chunks
CREATE TABLE file_chunks (
  file_id UUID REFERENCES files(id),
  chunk_index INTEGER,
  chunk_hash VARCHAR(64) NOT NULL,
  chunk_size INTEGER NOT NULL,
  PRIMARY KEY (file_id, chunk_index)
);

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
  width INTEGER,
  height INTEGER,
  full_res_size BIGINT,
  metadata JSONB,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_photos_user_date ON photos(user_id, taken_at DESC);

-- Shared Albums
CREATE TABLE shared_albums (
  id UUID PRIMARY KEY,
  owner_id UUID REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE album_photos (
  album_id UUID REFERENCES shared_albums(id),
  photo_id UUID REFERENCES photos(id),
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (album_id, photo_id)
);

CREATE TABLE album_subscribers (
  album_id UUID REFERENCES shared_albums(id),
  user_id UUID REFERENCES users(id),
  can_contribute BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (album_id, user_id)
);
```

---

## Key Design Decisions

### 1. Version Vectors

**Decision**: Use version vectors for conflict detection

**Rationale**:
- Detects concurrent edits across devices
- No central coordinator needed
- Handles network partitions

### 2. Chunk-Based Storage

**Decision**: Split files into content-addressed chunks

**Rationale**:
- Enables deduplication
- Efficient delta sync
- Resumable uploads/downloads

### 3. Optimized Storage Mode

**Decision**: Replace full-res photos with previews on device

**Rationale**:
- Saves device storage
- Full-res always in cloud
- Download on demand

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Sync model | Version vectors | Timestamps | Conflict detection |
| Storage | Chunked, content-addressed | Whole file | Deduplication, delta |
| Encryption | Per-file keys | Single user key | Key rotation, sharing |
| Photos | Optimized on-device | Full sync | Device storage limits |

---

## Caching and Edge Strategy

### CDN Layer (Static Assets and Photo Derivatives)

**Architecture:**
```
Client -> CloudFront/CDN -> Origin (MinIO/S3)
                         -> API Gateway (cache miss)
```

**What to Cache at CDN:**
- Photo derivatives (thumbnails, previews) - high read frequency
- Public shared album assets
- Static UI assets and app bundles

**CDN Configuration:**
```javascript
const cdnConfig = {
  // Photo derivatives - long cache, versioned by hash
  photoDerivatives: {
    ttl: 31536000,  // 1 year (immutable content-addressed)
    cacheKey: 'derivative-hash',
    headers: {
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  },

  // Shared album metadata - short cache
  sharedAlbumMeta: {
    ttl: 60,  // 1 minute
    staleWhileRevalidate: 300,
    headers: {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300'
    }
  }
}
```

### Redis/Valkey Cache Layer

**Cache-Aside Pattern (Read-Heavy Data):**

Used for data that is read frequently but written infrequently.

```javascript
class CacheAside {
  constructor(redis, db, defaultTTL = 3600) {
    this.redis = redis
    this.db = db
    this.defaultTTL = defaultTTL
  }

  async getFileMetadata(fileId) {
    const cacheKey = `file:meta:${fileId}`

    // 1. Try cache first
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached)
    }

    // 2. Cache miss - fetch from database
    const metadata = await this.db.query(
      'SELECT * FROM files WHERE id = $1',
      [fileId]
    )

    // 3. Populate cache
    if (metadata.rows[0]) {
      await this.redis.setex(
        cacheKey,
        this.defaultTTL,
        JSON.stringify(metadata.rows[0])
      )
    }

    return metadata.rows[0]
  }

  // Invalidate on write
  async updateFileMetadata(fileId, updates) {
    await this.db.query(
      'UPDATE files SET name = $2, modified_at = NOW() WHERE id = $1',
      [fileId, updates.name]
    )

    // Invalidate cache
    await this.redis.del(`file:meta:${fileId}`)
  }
}
```

**Write-Through Pattern (Sync State):**

Used for critical data where cache and DB must stay consistent.

```javascript
class WriteThrough {
  async updateSyncState(deviceId, userId, syncToken) {
    const cacheKey = `sync:state:${deviceId}:${userId}`
    const data = {
      lastSyncToken: syncToken,
      lastSyncAt: new Date().toISOString()
    }

    // Write to both cache AND database atomically
    await Promise.all([
      this.redis.setex(cacheKey, 86400, JSON.stringify(data)),
      this.db.query(`
        INSERT INTO device_sync_state (device_id, user_id, last_sync_token, last_sync_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (device_id, user_id)
        DO UPDATE SET last_sync_token = $3, last_sync_at = NOW()
      `, [deviceId, userId, syncToken])
    ])

    return data
  }
}
```

### TTL Strategy by Data Type

| Data Type | TTL | Pattern | Invalidation |
|-----------|-----|---------|--------------|
| File metadata | 1 hour | Cache-aside | On file update/delete |
| User storage quota | 5 minutes | Cache-aside | On upload/delete |
| Sync state cursor | 24 hours | Write-through | On sync completion |
| Photo derivatives | Forever | CDN + content-hash | Never (immutable) |
| Chunk existence | 1 hour | Cache-aside | On chunk upload |
| Device list | 15 minutes | Cache-aside | On device register/remove |

### Cache Invalidation Rules

```javascript
class CacheInvalidator {
  constructor(redis, pubsub) {
    this.redis = redis
    this.pubsub = pubsub
  }

  // Explicit invalidation on write operations
  async onFileUpdated(fileId, userId) {
    const keys = [
      `file:meta:${fileId}`,
      `user:files:${userId}:list`,
      `user:storage:${userId}`
    ]
    await this.redis.del(...keys)

    // Notify other cache instances via pub/sub
    await this.pubsub.publish('cache:invalidate', {
      keys,
      timestamp: Date.now()
    })
  }

  // Bulk invalidation for folder operations
  async onFolderDeleted(folderId, userId) {
    // Use scan to find all matching keys (avoid KEYS in production)
    const pattern = `file:meta:${folderId}:*`
    let cursor = '0'

    do {
      const [newCursor, keys] = await this.redis.scan(
        cursor, 'MATCH', pattern, 'COUNT', 100
      )
      cursor = newCursor

      if (keys.length > 0) {
        await this.redis.del(...keys)
      }
    } while (cursor !== '0')
  }
}
```

### Local Development Cache Setup

```yaml
# docker-compose.yml addition
services:
  valkey:
    image: valkey/valkey:7-alpine
    ports:
      - "6379:6379"
    command: valkey-server --maxmemory 256mb --maxmemory-policy allkeys-lru
```

---

## Observability

### Metrics Collection

**Key Metrics by Category:**

```javascript
const metrics = {
  // Sync performance
  'sync.duration_ms': 'histogram',      // Time to complete sync cycle
  'sync.files_uploaded': 'counter',     // Files uploaded per sync
  'sync.files_downloaded': 'counter',   // Files downloaded per sync
  'sync.conflicts_detected': 'counter', // Conflicts found
  'sync.conflicts_resolved': 'counter', // Auto-resolved conflicts

  // Storage operations
  'storage.chunk_upload_ms': 'histogram',   // Chunk upload latency
  'storage.chunk_download_ms': 'histogram', // Chunk download latency
  'storage.dedup_hits': 'counter',          // Chunks skipped (already exist)
  'storage.bytes_uploaded': 'counter',      // Total bytes uploaded

  // Cache performance
  'cache.hit_rate': 'gauge',           // Cache hit ratio
  'cache.miss_count': 'counter',       // Cache misses
  'cache.eviction_count': 'counter',   // Keys evicted

  // API health
  'api.request_duration_ms': 'histogram', // Request latency by endpoint
  'api.error_rate': 'gauge',              // 5xx error rate
  'api.active_connections': 'gauge'       // WebSocket connections
}
```

**Prometheus Instrumentation Example:**

```javascript
import { Registry, Histogram, Counter, Gauge } from 'prom-client'

const registry = new Registry()

const syncDuration = new Histogram({
  name: 'icloud_sync_duration_seconds',
  help: 'Duration of sync operations',
  labelNames: ['device_type', 'result'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry]
})

const conflictsDetected = new Counter({
  name: 'icloud_conflicts_total',
  help: 'Total number of sync conflicts detected',
  labelNames: ['file_type', 'resolution'],
  registers: [registry]
})

// Usage in sync engine
async function sync() {
  const timer = syncDuration.startTimer({ device_type: 'mac' })
  try {
    await performSync()
    timer({ result: 'success' })
  } catch (err) {
    timer({ result: 'error' })
    throw err
  }
}
```

### Structured Logging

**Log Format (JSON Lines):**

```javascript
const logger = {
  info: (event, data) => console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    event,
    ...data,
    service: 'sync-service',
    version: process.env.APP_VERSION
  })),

  error: (event, error, data) => console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    event,
    error: {
      message: error.message,
      stack: error.stack,
      code: error.code
    },
    ...data,
    service: 'sync-service'
  }))
}

// Example log entries
logger.info('sync.started', {
  userId: 'user-123',
  deviceId: 'device-456',
  filesChanged: 15
})

logger.info('chunk.uploaded', {
  userId: 'user-123',
  fileId: 'file-789',
  chunkHash: 'abc123...',
  sizeBytes: 4194304,
  durationMs: 450,
  deduplicated: false
})

logger.error('sync.failed', error, {
  userId: 'user-123',
  deviceId: 'device-456',
  phase: 'upload'
})
```

### Distributed Tracing

**OpenTelemetry Integration:**

```javascript
import { trace, SpanKind } from '@opentelemetry/api'

const tracer = trace.getTracer('icloud-sync')

async function uploadFile(fileId, filePath) {
  return tracer.startActiveSpan('file.upload', {
    kind: SpanKind.CLIENT,
    attributes: {
      'file.id': fileId,
      'file.path': filePath
    }
  }, async (span) => {
    try {
      // Chunking phase
      const chunks = await tracer.startActiveSpan('file.chunk', async (chunkSpan) => {
        const result = await splitIntoChunks(filePath)
        chunkSpan.setAttribute('chunk.count', result.length)
        chunkSpan.end()
        return result
      })

      // Upload each chunk
      for (const chunk of chunks) {
        await tracer.startActiveSpan('chunk.upload', {
          attributes: { 'chunk.hash': chunk.hash, 'chunk.size': chunk.size }
        }, async (uploadSpan) => {
          await uploadChunkToStorage(chunk)
          uploadSpan.end()
        })
      }

      span.setStatus({ code: 0 })
    } catch (error) {
      span.setStatus({ code: 2, message: error.message })
      span.recordException(error)
      throw error
    } finally {
      span.end()
    }
  })
}
```

### SLI Dashboard Definitions

**Grafana Dashboard Panels:**

| Panel | Query | Purpose |
|-------|-------|---------|
| Sync Success Rate | `rate(icloud_sync_duration_seconds_count{result="success"}[5m]) / rate(icloud_sync_duration_seconds_count[5m])` | Track sync reliability |
| P95 Sync Latency | `histogram_quantile(0.95, rate(icloud_sync_duration_seconds_bucket[5m]))` | Sync performance |
| Conflict Rate | `rate(icloud_conflicts_total[1h])` | Data consistency health |
| Cache Hit Rate | `rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m]))` | Cache effectiveness |
| Storage Dedup Ratio | `rate(storage_dedup_hits_total[1h]) / rate(storage_chunks_processed_total[1h])` | Storage efficiency |
| Active WebSocket Connections | `icloud_websocket_connections` | Real-time sync capacity |

### Alert Thresholds

```yaml
# alerts.yml
groups:
  - name: icloud-slis
    rules:
      - alert: SyncLatencyHigh
        expr: histogram_quantile(0.95, rate(icloud_sync_duration_seconds_bucket[5m])) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Sync P95 latency exceeds 10 seconds"

      - alert: SyncErrorRateHigh
        expr: rate(icloud_sync_duration_seconds_count{result="error"}[5m]) / rate(icloud_sync_duration_seconds_count[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Sync error rate exceeds 5%"

      - alert: CacheHitRateLow
        expr: rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m])) < 0.8
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Cache hit rate below 80%"

      - alert: ConflictRateSpike
        expr: rate(icloud_conflicts_total[5m]) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Unusual spike in sync conflicts"

      - alert: StorageQuotaExceeded
        expr: icloud_user_storage_used_bytes / icloud_user_storage_quota_bytes > 0.95
        for: 1m
        labels:
          severity: info
        annotations:
          summary: "User approaching storage quota limit"
```

### Audit Logging

**Security and Compliance Events:**

```javascript
class AuditLogger {
  constructor(db) {
    this.db = db
  }

  async log(event) {
    await this.db.query(`
      INSERT INTO audit_log (
        event_type, user_id, device_id, resource_type, resource_id,
        action, metadata, ip_address, user_agent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `, [
      event.type,
      event.userId,
      event.deviceId,
      event.resourceType,
      event.resourceId,
      event.action,
      JSON.stringify(event.metadata),
      event.ipAddress,
      event.userAgent
    ])
  }
}

// Audit events to capture
const auditEvents = {
  // Authentication
  'auth.login': { retention: '2 years' },
  'auth.logout': { retention: '2 years' },
  'auth.device_registered': { retention: '2 years' },
  'auth.device_removed': { retention: '2 years' },

  // Data access
  'file.shared': { retention: '1 year' },
  'file.downloaded': { retention: '90 days' },
  'album.shared': { retention: '1 year' },
  'album.unshared': { retention: '1 year' },

  // Administrative
  'admin.user_suspended': { retention: '5 years' },
  'admin.data_export': { retention: '5 years' },
  'admin.data_deleted': { retention: '5 years' }
}

// Usage
await auditLogger.log({
  type: 'file.shared',
  userId: 'user-123',
  deviceId: 'device-456',
  resourceType: 'file',
  resourceId: 'file-789',
  action: 'create_share_link',
  metadata: {
    shareType: 'public',
    expiresAt: '2024-12-31'
  },
  ipAddress: req.ip,
  userAgent: req.headers['user-agent']
})
```

**Audit Log Schema:**

```sql
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
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_user_time ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_event_type ON audit_log(event_type, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id, created_at DESC);
```

---

## Failure Handling

### Retry Strategy with Idempotency Keys

**Idempotent Upload Operations:**

```javascript
class IdempotentUploader {
  constructor(redis, storage, db) {
    this.redis = redis
    this.storage = storage
    this.db = db
  }

  async uploadFile(idempotencyKey, fileId, fileData, userId) {
    const lockKey = `upload:lock:${idempotencyKey}`
    const resultKey = `upload:result:${idempotencyKey}`

    // Check if this request was already processed
    const existingResult = await this.redis.get(resultKey)
    if (existingResult) {
      return JSON.parse(existingResult)
    }

    // Acquire lock to prevent duplicate processing
    const lockAcquired = await this.redis.set(
      lockKey,
      'locked',
      'NX',
      'EX',
      300  // 5 minute lock
    )

    if (!lockAcquired) {
      // Another request is processing this - wait and return result
      await this.waitForResult(resultKey)
      return JSON.parse(await this.redis.get(resultKey))
    }

    try {
      // Perform the actual upload
      const result = await this.performUpload(fileId, fileData, userId)

      // Store result for 24 hours
      await this.redis.setex(resultKey, 86400, JSON.stringify(result))

      return result
    } finally {
      await this.redis.del(lockKey)
    }
  }

  async waitForResult(resultKey, maxWaitMs = 30000) {
    const startTime = Date.now()
    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.redis.get(resultKey)
      if (result) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Timeout waiting for upload result')
  }
}
```

**Client-Side Retry with Exponential Backoff:**

```javascript
class RetryClient {
  constructor(maxRetries = 3, baseDelayMs = 1000) {
    this.maxRetries = maxRetries
    this.baseDelayMs = baseDelayMs
  }

  async uploadWithRetry(fileId, fileData) {
    // Generate idempotency key from file content hash
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(fileId + fileData.slice(0, 1024))
      .digest('hex')

    let lastError

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch('/api/v1/files/upload', {
          method: 'POST',
          headers: {
            'Idempotency-Key': idempotencyKey,
            'Content-Type': 'application/octet-stream'
          },
          body: fileData
        })

        if (response.ok) {
          return await response.json()
        }

        // Don't retry 4xx errors (client error)
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`Client error: ${response.status}`)
        }

        lastError = new Error(`Server error: ${response.status}`)
      } catch (error) {
        lastError = error
      }

      if (attempt < this.maxRetries) {
        // Exponential backoff with jitter
        const delay = this.baseDelayMs * Math.pow(2, attempt)
        const jitter = delay * 0.2 * Math.random()
        await new Promise(r => setTimeout(r, delay + jitter))
      }
    }

    throw lastError
  }
}
```

### Circuit Breaker Pattern

**Storage Service Circuit Breaker:**

```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeoutMs = options.resetTimeoutMs || 30000
    this.halfOpenMaxCalls = options.halfOpenMaxCalls || 3

    this.state = 'closed'  // closed, open, half-open
    this.failureCount = 0
    this.successCount = 0
    this.lastFailureTime = null
    this.halfOpenCalls = 0
  }

  async execute(fn) {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'half-open'
        this.halfOpenCalls = 0
      } else {
        throw new Error('Circuit breaker is open')
      }
    }

    if (this.state === 'half-open' && this.halfOpenCalls >= this.halfOpenMaxCalls) {
      throw new Error('Circuit breaker half-open limit reached')
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    if (this.state === 'half-open') {
      this.successCount++
      if (this.successCount >= this.halfOpenMaxCalls) {
        this.state = 'closed'
        this.failureCount = 0
        this.successCount = 0
      }
    } else {
      this.failureCount = 0
    }
  }

  onFailure() {
    this.failureCount++
    this.lastFailureTime = Date.now()

    if (this.state === 'half-open') {
      this.state = 'open'
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = 'open'
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime
    }
  }
}

// Usage
const storageBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 30000
})

async function uploadChunk(hash, data) {
  return storageBreaker.execute(async () => {
    return await minioClient.putObject('chunks', hash, data)
  })
}
```

**Circuit Breaker Middleware:**

```javascript
const circuitBreakers = {
  storage: new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30000 }),
  database: new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60000 }),
  externalApi: new CircuitBreaker({ failureThreshold: 10, resetTimeoutMs: 120000 })
}

// Health endpoint shows circuit breaker states
app.get('/health/circuits', (req, res) => {
  res.json({
    storage: circuitBreakers.storage.getState(),
    database: circuitBreakers.database.getState(),
    externalApi: circuitBreakers.externalApi.getState()
  })
})
```

### Multi-Region Disaster Recovery (Conceptual)

**For Local Development Learning:**

While full multi-region DR is impractical locally, understand the patterns:

```javascript
// Simulated region failover for learning
class RegionManager {
  constructor() {
    this.regions = [
      { id: 'primary', endpoint: 'http://localhost:3001', healthy: true },
      { id: 'secondary', endpoint: 'http://localhost:3002', healthy: true }
    ]
    this.activeRegion = this.regions[0]
  }

  async healthCheck() {
    for (const region of this.regions) {
      try {
        const response = await fetch(`${region.endpoint}/health`, {
          timeout: 5000
        })
        region.healthy = response.ok
      } catch {
        region.healthy = false
      }
    }
  }

  getActiveEndpoint() {
    // Return first healthy region
    const healthy = this.regions.find(r => r.healthy)
    if (!healthy) {
      throw new Error('No healthy regions available')
    }
    return healthy.endpoint
  }

  async failover() {
    await this.healthCheck()
    const newActive = this.regions.find(r => r.healthy && r.id !== this.activeRegion.id)

    if (newActive) {
      console.log(`Failing over from ${this.activeRegion.id} to ${newActive.id}`)
      this.activeRegion = newActive
      return true
    }
    return false
  }
}
```

**DR Checklist for Production:**

| Component | Primary | Secondary | RPO | RTO |
|-----------|---------|-----------|-----|-----|
| PostgreSQL | us-east-1 | us-west-2 | 1 minute (async replication) | 15 minutes |
| MinIO/S3 | us-east-1 | us-west-2 | 0 (cross-region replication) | 5 minutes |
| Valkey/Redis | us-east-1 | us-west-2 | 5 minutes | 10 minutes |
| Cassandra | Multi-DC | Multi-DC | 0 (multi-master) | 0 (automatic) |

### Backup and Restore Testing

**Automated Backup Verification:**

```javascript
class BackupValidator {
  constructor(db, storage) {
    this.db = db
    this.storage = storage
  }

  // Run nightly in non-production environments
  async validateBackups() {
    const report = {
      timestamp: new Date().toISOString(),
      checks: []
    }

    // 1. Verify PostgreSQL backup exists and is recent
    const pgBackup = await this.checkPostgresBackup()
    report.checks.push({
      name: 'postgresql_backup',
      status: pgBackup.valid ? 'pass' : 'fail',
      lastBackup: pgBackup.timestamp,
      sizeBytes: pgBackup.size
    })

    // 2. Verify chunk storage backup/replication
    const storageBackup = await this.checkStorageReplication()
    report.checks.push({
      name: 'storage_replication',
      status: storageBackup.inSync ? 'pass' : 'fail',
      lagBytes: storageBackup.replicationLag
    })

    // 3. Sample restore test (restore random file)
    const restoreTest = await this.sampleRestoreTest()
    report.checks.push({
      name: 'sample_restore',
      status: restoreTest.success ? 'pass' : 'fail',
      durationMs: restoreTest.duration,
      fileId: restoreTest.fileId
    })

    return report
  }

  async checkPostgresBackup() {
    // Check backup exists in storage
    const backups = await this.storage.listObjects('backups', 'pg/')
    const latest = backups.sort((a, b) => b.lastModified - a.lastModified)[0]

    const ageHours = (Date.now() - latest.lastModified.getTime()) / 3600000

    return {
      valid: ageHours < 24,  // Backup should be less than 24 hours old
      timestamp: latest.lastModified,
      size: latest.size
    }
  }

  async sampleRestoreTest() {
    const startTime = Date.now()

    // Pick a random file from the database
    const randomFile = await this.db.query(`
      SELECT id, content_hash FROM files
      WHERE is_deleted = false
      ORDER BY RANDOM()
      LIMIT 1
    `)

    if (!randomFile.rows[0]) {
      return { success: true, duration: 0, fileId: null }
    }

    const fileId = randomFile.rows[0].id
    const expectedHash = randomFile.rows[0].content_hash

    try {
      // Attempt to reconstruct file from chunks
      const manifest = await this.getFileManifest(fileId)
      const chunks = []

      for (const chunk of manifest.chunks) {
        const data = await this.storage.getObject('chunks', chunk.hash)
        chunks.push(data)
      }

      // Verify reconstructed file hash
      const reconstructed = Buffer.concat(chunks)
      const actualHash = crypto
        .createHash('sha256')
        .update(reconstructed)
        .digest('hex')

      return {
        success: actualHash === expectedHash,
        duration: Date.now() - startTime,
        fileId
      }
    } catch (error) {
      return {
        success: false,
        duration: Date.now() - startTime,
        fileId,
        error: error.message
      }
    }
  }
}
```

**Backup Schedule:**

```yaml
# backup-schedule.yml
backups:
  postgresql:
    type: pg_dump
    frequency: daily
    retention: 30 days
    destination: s3://icloud-backups/pg/

  postgresql_wal:
    type: continuous
    retention: 7 days
    destination: s3://icloud-backups/pg-wal/

  chunk_storage:
    type: cross-region-replication
    frequency: continuous
    destination: s3://icloud-chunks-replica/

restore_tests:
  frequency: weekly
  scope: sample  # full, sample, metadata-only
  notification: ops-team@example.com
```

**Local Development Backup Commands:**

```bash
# Backup PostgreSQL
pg_dump -h localhost -U icloud icloud_db > backup_$(date +%Y%m%d).sql

# Restore PostgreSQL
psql -h localhost -U icloud icloud_db < backup_20240115.sql

# Backup MinIO bucket
mc mirror minio/icloud-chunks ./backup-chunks/

# Restore MinIO bucket
mc mirror ./backup-chunks/ minio/icloud-chunks
```

---

## Implementation Notes

This section documents the actual implementation of the observability, caching, and failure handling patterns described above. Each implementation addresses specific production concerns.

### Structured Logging with Pino

**File:** `backend/src/shared/logger.js`

**Why Pino:** Pino is the fastest JSON logger for Node.js, essential for high-throughput sync operations. Structured JSON logs enable:

- **Log Aggregation:** Tools like ELK, Loki, or CloudWatch can parse and query logs efficiently
- **Correlation IDs:** Each request gets a unique ID, making it easy to trace a sync operation across services
- **Audit Trail:** Security-relevant events (file shares, device registrations) are logged separately for compliance

**Key Features:**
- Development mode uses `pino-pretty` for human-readable console output
- Production mode outputs raw JSON for log aggregators
- Request middleware attaches `req.log` with correlation ID for all routes
- Separate audit logger for compliance events with longer retention

**Example Log Output:**
```json
{
  "level": "info",
  "time": "2024-01-15T10:30:00.000Z",
  "correlationId": "abc-123",
  "event": "sync.push_completed",
  "userId": "user-456",
  "applied": 5,
  "conflicts": 1,
  "errors": 0
}
```

### Prometheus Metrics

**File:** `backend/src/shared/metrics.js`

**Why Prometheus:** Industry-standard for cloud-native monitoring. RED method (Rate, Errors, Duration) metrics enable SLO tracking.

**Metrics Categories:**

| Category | Metric | Type | Purpose |
|----------|--------|------|---------|
| HTTP | `icloud_http_request_duration_seconds` | Histogram | API latency by endpoint |
| Sync | `icloud_sync_duration_seconds` | Histogram | Sync operation timing |
| Sync | `icloud_conflicts_total` | Counter | Track conflict frequency |
| Storage | `icloud_chunk_operation_duration_seconds` | Histogram | MinIO latency |
| Storage | `icloud_dedup_hits_total` | Counter | Deduplication effectiveness |
| Cache | `icloud_cache_hits_total` | Counter | Cache hit rate |
| Circuit | `icloud_circuit_breaker_state` | Gauge | Breaker open/closed status |

**Grafana Queries for SLI Dashboard:**
```promql
# Sync Success Rate (SLO: 99.9%)
sum(rate(icloud_sync_operations_total{result="success"}[5m])) /
sum(rate(icloud_sync_operations_total[5m]))

# P95 Sync Latency (SLO: <5s)
histogram_quantile(0.95, rate(icloud_sync_duration_seconds_bucket[5m]))

# Cache Hit Rate (Target: >85%)
rate(icloud_cache_hits_total[5m]) /
(rate(icloud_cache_hits_total[5m]) + rate(icloud_cache_misses_total[5m]))
```

**Endpoint:** `GET /metrics` returns Prometheus-formatted metrics for scraping.

### Redis Caching Strategy

**File:** `backend/src/shared/cache.js`

**Why Two Patterns:**

1. **Cache-Aside (Read-Heavy Data):** Used for file metadata and storage quotas. Tolerates stale reads for 1 hour. On cache miss, fetches from PostgreSQL and populates cache.

2. **Write-Through (Critical Data):** Used for device sync state. Writes to both cache and database atomically. Ensures consistency for sync cursor (losing this could cause duplicate syncs).

**TTL Configuration:**

| Data Type | TTL | Pattern | Rationale |
|-----------|-----|---------|-----------|
| File Metadata | 1 hour | Cache-aside | Files change infrequently |
| User Storage | 5 min | Cache-aside | Updates on upload/delete |
| Sync State | 24 hours | Write-through | Critical, must be consistent |
| Chunk Exists | 1 hour | Cache-aside | Dedup check optimization |
| Idempotency Keys | 24 hours | Cache-aside | Retry window |

**Cache Invalidation:** On file update, we invalidate:
- `file:meta:{fileId}` - The specific file
- `user:storage:{userId}` - Storage quota (may have changed)

### Circuit Breaker for Storage

**File:** `backend/src/shared/circuitBreaker.js`

**Why Circuit Breaker:** MinIO/S3 failures can cascade to the entire sync service. Without protection:
- Requests pile up waiting for timeout
- Thread pool exhaustion
- User-visible latency spikes

**How It Works:**

```
         Requests
             │
             ▼
      ┌─────────────┐
      │   CLOSED    │ ─── Normal operation
      └─────────────┘
             │
        5 failures
             │
             ▼
      ┌─────────────┐
      │    OPEN     │ ─── Fail fast (30s)
      └─────────────┘
             │
        30s timeout
             │
             ▼
      ┌─────────────┐
      │  HALF-OPEN  │ ─── Test recovery
      └─────────────┘
             │
        3 successes
             │
             ▼
      ┌─────────────┐
      │   CLOSED    │ ─── Resume normal
      └─────────────┘
```

**Configuration:**
- `errorThresholdPercentage: 50` - Open when 50% of requests fail
- `resetTimeout: 30000` - Try again after 30 seconds
- `timeout: 30000` - Individual request timeout for uploads

**Separate Breakers:** We use different breakers for different operations:
- `storage_put` - Longer timeout (30s) for large uploads
- `storage_get` - Medium timeout (15s) for downloads
- `storage_stat` - Short timeout (5s) for existence checks

### Idempotency for Sync Operations

**File:** `backend/src/shared/idempotency.js`

**Why Idempotency:** Sync operations are particularly vulnerable to duplicate processing:

1. Client times out after 30 seconds
2. Server actually processed the request
3. Client retries with same changes
4. Without idempotency: duplicate files or incorrect version vectors

**How It Works:**

```
Client Request (with Idempotency-Key header)
             │
             ▼
      ┌──────────────────┐
      │ Check Redis for  │
      │ existing result  │
      └──────────────────┘
             │
     ┌───────┴───────┐
     │               │
   Found          Not Found
     │               │
     ▼               ▼
 Return          Acquire Lock
 Cached          (5 min TTL)
 Result              │
                     ▼
              Execute Handler
                     │
                     ▼
              Save Result
              (24 hour TTL)
                     │
                     ▼
              Release Lock
```

**Key Design Decisions:**

1. **Lock with TTL:** If server crashes, lock auto-expires after 5 minutes
2. **Result Caching:** Store full response for 24 hours for exact replay
3. **Conflict Handling:** If another request is processing, wait up to 30s or return 409
4. **Opt-in:** Routes use `withIdempotency()` wrapper for operations that need it

**Client Integration:**
```javascript
// Client generates key from content
const idempotencyKey = sha256(userId + operation + JSON.stringify(changes));

fetch('/api/v1/sync/push', {
  method: 'POST',
  headers: {
    'Idempotency-Key': idempotencyKey,
  },
  body: JSON.stringify({ changes }),
});
```

### Health Checks

**File:** `backend/src/shared/health.js`

**Three Endpoints for Different Purposes:**

| Endpoint | Purpose | Checks | Use Case |
|----------|---------|--------|----------|
| `/health/live` | Liveness | None | Kubernetes restart probe |
| `/health/ready` | Readiness | DB + Redis | Load balancer routing |
| `/health` | Full status | All components | Debugging, dashboards |

**Full Health Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime": 3600,
  "version": "1.0.0",
  "components": {
    "postgres": {
      "status": "healthy",
      "latencyMs": 2,
      "poolInfo": {
        "totalCount": 20,
        "idleCount": 18,
        "waitingCount": 0
      }
    },
    "redis": {
      "status": "healthy",
      "latencyMs": 1,
      "memoryUsedBytes": 1048576
    },
    "storage": {
      "status": "healthy",
      "latencyMs": 15,
      "bucketsCount": 3
    },
    "circuitBreakers": {
      "status": "healthy",
      "breakers": {
        "put": { "state": "closed", "stats": {...} },
        "get": { "state": "closed", "stats": {...} }
      }
    }
  }
}
```

### Running the Implementation

**Start Infrastructure:**
```bash
docker-compose up -d
```

**Start Backend with Observability:**
```bash
cd backend
npm run dev
```

**Verify Health:**
```bash
curl http://localhost:3001/health
```

**View Metrics:**
```bash
curl http://localhost:3001/metrics
```

**Test Idempotency:**
```bash
# First request
curl -X POST http://localhost:3001/api/v1/sync/push \
  -H "Idempotency-Key: test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"changes": []}'

# Duplicate request returns same result without re-processing
curl -X POST http://localhost:3001/api/v1/sync/push \
  -H "Idempotency-Key: test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"changes": []}'
```
