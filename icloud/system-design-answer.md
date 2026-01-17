# iCloud Sync - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design iCloud, a file and photo synchronization service that keeps data consistent across all Apple devices. The core challenge here is building a bidirectional sync system that handles conflicts gracefully, works offline, and efficiently transfers large files while maintaining end-to-end encryption for user privacy.

This involves three key technical challenges: implementing version vectors for conflict detection, designing chunk-based file transfer for efficiency, and building an offline-first architecture that syncs when connectivity is restored."

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

### Core Components

1. **Sync Service**: Manages file metadata, detects changes, and coordinates sync
2. **Photo Service**: Handles photo library with derivative generation and smart storage
3. **CloudKit**: Provides app-level data sync with key-value and structured storage
4. **Object Storage**: Content-addressed chunk storage with deduplication
5. **Cassandra**: High-availability sync state and version vector storage

## Deep Dive: Version Vectors and Conflict Detection (8 minutes)

This is the heart of the sync system. We need to detect when the same file was modified on multiple devices before syncing.

### Version Vector Approach

Each file has a version vector: `{deviceId: sequenceNumber}`. When a device edits a file, it increments its own sequence number.

```javascript
// Version comparison logic
compareVersions(localVersion, serverVersion) {
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
```

### Conflict Scenarios

**No Conflict**: Versions form a linear chain (one device's edits happened after the other)
- Local: `{A: 3, B: 2}`, Server: `{A: 2, B: 2}` → Local wins

**Conflict**: Both devices edited independently
- Local: `{A: 3, B: 2}`, Server: `{A: 2, B: 3}` → Conflict!

### Conflict Resolution Strategy

```javascript
async resolveConflict(conflict) {
  const { fileId, local, server } = conflict;
  const fileType = this.getFileType(fileId);

  switch (fileType) {
    case 'text':
      // Try three-way merge using common ancestor
      return this.mergeTextFiles(local, server);

    case 'photo':
      // Keep both as separate files
      return this.keepBoth(local, server);

    case 'document':
      // Last-write-wins, but keep conflict copy
      return this.lastWriteWinsWithCopy(local, server);

    default:
      // Ask user to choose
      return this.promptUser(local, server);
  }
}
```

### Why Version Vectors over Timestamps?

| Approach | Pros | Cons |
|----------|------|------|
| Timestamps | Simple | Clock drift, no causality |
| Version Vectors | Detects true conflicts | More complex |
| Lamport Clocks | Ordered events | No concurrency detection |

Version vectors tell us not just which is newer, but whether edits were concurrent (conflict) or sequential (no conflict).

## Deep Dive: Chunk-Based File Transfer (7 minutes)

Large files need efficient transfer. We split files into content-addressed chunks.

### Chunking Strategy

```javascript
class ChunkedUploader {
  constructor(chunkSize = 4 * 1024 * 1024) { // 4MB chunks
    this.chunkSize = chunkSize;
  }

  async uploadFile(fileId, filePath) {
    const fileSize = await fs.stat(filePath).size;

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

      // Only upload if chunk doesn't exist (deduplication!)
      if (!existingHashes.has(hash)) {
        await this.uploadChunk(hash, data);
      }

      chunkIndex++;
    }

    // Update file manifest
    await this.updateFileManifest(fileId, { chunks, totalSize: fileSize });
    return chunks;
  }
}
```

### Benefits of Chunking

1. **Deduplication**: Same chunk across files stored once
2. **Delta Sync**: Only upload changed chunks
3. **Resumable**: Interrupted uploads continue from last chunk
4. **Parallel**: Upload/download multiple chunks simultaneously

### Chunk Reference Counting

```sql
-- When files share chunks, we use reference counting
CREATE TABLE chunk_store (
  hash VARCHAR(64) PRIMARY KEY,
  size INTEGER,
  reference_count INTEGER DEFAULT 1,
  storage_key VARCHAR(200)
);

-- When a file is deleted, decrement refs; cleanup when 0
```

### Content-Defined Chunking (Future Optimization)

Fixed-size chunking has a problem: inserting 1 byte shifts all subsequent chunk boundaries. Content-defined chunking (like Rabin fingerprinting) creates boundaries based on content, making deltas more efficient.

## Deep Dive: Photo Library Optimization (6 minutes)

Photos are the largest storage category. We need smart storage management.

### Tiered Storage

```javascript
class PhotoLibrary {
  async syncPhoto(photo) {
    // Upload full resolution to cloud
    const fullResHash = await this.uploadOriginal(photo);

    // Generate derivatives on server
    const derivatives = {
      thumbnail: await this.resize(photo, 200, 200),   // For grid view
      preview: await this.resize(photo, 1024, 1024),   // For preview
      display: await this.resize(photo, 2048, 2048)    // For full screen
    };

    // Device only keeps preview by default
    // Full-res downloaded on demand
  }

  async optimizeDeviceStorage(deviceId, targetFreeSpace) {
    // Get photos sorted by last viewed (LRU)
    const photos = await db.query(`
      SELECT p.*, dp.last_viewed
      FROM photos p
      JOIN device_photos dp ON p.id = dp.photo_id
      WHERE dp.device_id = $1 AND dp.has_full_res = true
      ORDER BY dp.last_viewed ASC
    `, [deviceId]);

    let freedSpace = 0;
    const toOptimize = [];

    for (const photo of photos.rows) {
      if (freedSpace >= targetFreeSpace) break;
      toOptimize.push(photo.id);
      freedSpace += photo.full_res_size - photo.preview_size;
    }

    return { photosToOptimize: toOptimize, estimatedFreedSpace: freedSpace };
  }
}
```

### Smart Download

When a user views a photo, we:
1. Show preview immediately (already on device)
2. Download full-res in background if not present
3. Track last-viewed for LRU eviction

### Shared Albums

Shared albums use a pub/sub model:
- Owner publishes changes
- Subscribers get notified via WebSocket
- Contributors can add photos (if permissions allow)

## Trade-offs and Alternatives (5 minutes)

### 1. Version Vectors vs. Operational Transform

**Chose: Version Vectors**
- Pro: Simpler, works for any file type
- Con: Can't auto-merge most file types
- Alternative: Operational Transform (OT) or CRDTs for text documents
- OT would be better for collaborative editing but complex to implement

### 2. Fixed vs. Content-Defined Chunking

**Chose: Fixed 4MB chunks (initially)**
- Pro: Simple, predictable
- Con: Poor delta efficiency for insertions
- Alternative: Content-defined chunking (Rabin fingerprinting)
- Would implement CDC as optimization for frequently-edited files

### 3. Push vs. Pull Sync

**Chose: Hybrid**
- Push: WebSocket notification when changes occur
- Pull: Periodic full sync as fallback
- Alternative: Pure polling (simpler but higher latency)

### 4. Encryption Strategy

**Chose: Per-file keys wrapped by user master key**
- Pro: Key rotation without re-encrypting all data
- Pro: Enables sharing (share file key, not master key)
- Con: Key management complexity
- Alternative: Single user key (simpler but inflexible)

### 5. Photo Storage Tiers

**Chose: Preview on device, full-res in cloud**
- Pro: Saves significant device storage
- Con: Network required for full-res viewing
- Trade-off: Download latency vs. device space

### Scalability Considerations

**Data Partitioning**:
- User data sharded by user ID
- Photo library is independent per user (no cross-user queries)
- Chunk store is global but content-addressed

**Caching Strategy**:
- Metadata cached in Redis (per-user)
- Chunk existence checked in Bloom filter
- Photo previews cached at CDN edge

## Closing Summary (1 minute)

"The iCloud sync system is built around three core innovations:

1. **Version Vectors** for conflict detection - enabling us to distinguish true concurrent edits from sequential changes
2. **Content-addressed chunk storage** for efficiency - achieving deduplication and delta sync
3. **Tiered photo storage** for device optimization - keeping previews local while storing full-resolution in the cloud

The key trade-off throughout is complexity vs. capability. We chose version vectors over simple timestamps because detecting true conflicts is essential for user trust. We chose chunk-based storage over whole-file sync because the bandwidth savings at scale are massive.

For future improvements, I'd prioritize content-defined chunking for better delta efficiency and implement CRDTs for collaborative document types like Notes."
