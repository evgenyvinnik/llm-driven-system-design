# Design iCloud Sync - Development with Claude

## Project Context

Building a file and photo synchronization service to understand sync protocols, conflict resolution, and cross-device consistency.

**Key Learning Goals:**
- Build bidirectional sync protocols
- Design conflict resolution systems
- Implement chunk-based file transfer
- Handle offline-first architecture

---

## Key Challenges to Explore

### 1. Sync Consistency

**Challenge**: Multiple devices editing same file

**Approaches:**
- Version vectors for causality
- Operational transformation
- CRDTs for mergeable types
- Last-write-wins with conflict copies

**Implementation:** Using version vectors (`{deviceId: sequenceNumber}`) to track causality and detect conflicts when vectors diverge.

### 2. Efficient Transfer

**Problem**: Minimize bandwidth for large files

**Solutions:**
- Content-defined chunking
- Rolling hash for delta detection
- Deduplication across files
- Compression before upload

**Implementation:** Files split into 4MB chunks with SHA-256 hashing. Chunks stored once in MinIO with reference counting for deduplication.

### 3. Photo Optimization

**Challenge**: TB of photos, limited device storage

**Solutions:**
- Thumbnail/preview on device
- Full-res in cloud
- Smart caching (recently viewed)
- Predictive prefetch

**Implementation:** Photos stored with three derivatives (thumbnail 200px, preview 1024px, full resolution). Device tracks which photos have full-res locally.

---

## Development Phases

### Phase 1: Basic Sync [COMPLETED]
- [x] File metadata tracking
- [x] Change detection
- [x] Upload/download
- [x] Version tracking

### Phase 2: Conflict Resolution [IN PROGRESS]
- [x] Version vectors
- [x] Conflict detection
- [x] Automatic merge
- [x] Conflict copies

### Phase 3: Optimization [COMPLETED]
- [x] Chunked transfer
- [x] Delta sync
- [x] Deduplication
- [ ] Compression (future enhancement)

### Phase 4: Photos [COMPLETED]
- [x] Photo library sync
- [x] Derivative generation
- [x] Optimized storage
- [x] Shared albums

---

## Implementation Notes

### Version Vector Comparison Logic

```javascript
compareVersions(localVersion, serverVersion) {
  let localNewer = false;
  let serverNewer = false;

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

### Chunk Deduplication

Each chunk is stored in a global `chunk_store` table with a reference count. When files share chunks (common with similar documents), storage is only used once. When files are deleted, reference counts decrement, and chunks with zero references are cleaned up.

### Real-time Sync

WebSocket connections notify devices of changes from other devices. Each user has a set of connected WebSocket clients, and file operations broadcast to all except the originating device.

---

## Future Enhancements

1. **Offline Support:** IndexedDB for local file cache, sync queue for pending operations
2. **Selective Sync:** Allow users to choose which folders sync to which devices
3. **Sharing:** Public links, shared folders with permission levels
4. **End-to-End Encryption:** Per-file keys wrapped with user's master key
5. **Compression:** gzip/zstd compression before chunk upload

---

## Resources

- [Dropbox Sync Engine](https://dropbox.tech/infrastructure/how-we-designed-dropbox-atf)
- [Vector Clocks](https://en.wikipedia.org/wiki/Vector_clock)
- [Content-Defined Chunking](https://restic.readthedocs.io/en/latest/100_references.html#design)
