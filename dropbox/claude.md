# Dropbox - Cloud Storage - Development with Claude

## Project Context

This document tracks the development journey of implementing a cloud file storage and synchronization service.

## Key Challenges to Explore

1. File chunking and deduplication
2. Sync conflict resolution
3. Storage optimization
4. Bandwidth management

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Questions explored:**
- Core features: File upload/download, folder hierarchy, versioning, sharing
- Scale: Local development with support for 2-5 server instances
- Technical constraints: Use MinIO for S3-compatible storage, PostgreSQL for metadata

**Decisions made:**
- 4MB fixed-size chunks for simplicity (content-defined chunking deferred)
- SHA-256 for chunk hashing (deduplication)
- PostgreSQL for metadata, MinIO for chunks, Redis for sessions

### Phase 2: Initial Implementation
*In Progress*

**Completed:**
- Backend API with Express + TypeScript
- File chunking and upload with deduplication
- Folder hierarchy and navigation
- File versioning with restore capability
- Share links with password/expiration/download limits
- Folder sharing with specific users
- Admin dashboard with system stats
- Frontend file browser with drag-and-drop upload
- Real-time sync notifications via WebSocket

**Remaining:**
- Desktop sync client
- Conflict resolution for simultaneous edits
- Content-defined chunking (Rabin fingerprinting)

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer for folder listings
- Optimize database queries with proper indexing
- Implement load balancing across server instances
- Add monitoring with Prometheus + Grafana
- Delta sync (only upload changed chunks)

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests
- Performance tuning
- Code cleanup

## Design Decisions Log

### 2024: Initial Implementation

**1. Fixed-size vs Content-defined Chunking**
- Chose: Fixed-size 4MB chunks
- Rationale: Simpler to implement, good enough for MVP
- Trade-off: Inserting bytes shifts all subsequent chunk boundaries
- Future: Could add Rabin fingerprinting for better delta sync

**2. PostgreSQL for Metadata**
- Chose: PostgreSQL with UUID primary keys
- Rationale: ACID compliance, good for hierarchical data (parent_id), familiar
- Trade-off: Single point of failure, sharding complexity at scale
- Alternative considered: CouchDB (eventual consistency not ideal for file metadata)

**3. MinIO for Chunk Storage**
- Chose: MinIO (S3-compatible)
- Rationale: Designed for object storage, easy local development, production-ready
- Trade-off: Additional service to manage
- Alternative considered: Local filesystem (doesn't scale)

**4. Soft Deletes**
- Chose: deleted_at timestamp instead of hard deletes
- Rationale: Enables trash/restore, audit trail, safer
- Trade-off: Queries need WHERE deleted_at IS NULL

**5. Chunk Reference Counting**
- Chose: reference_count column in chunks table
- Rationale: Know when chunk can be garbage collected
- Trade-off: Must maintain count on every file operation

## Iterations and Learnings

### Iteration 1: Basic Upload Flow
- Implemented simple single-file upload first
- Then added chunking for large files
- Key insight: Separate upload session from file creation for resumability

### Iteration 2: Deduplication
- Initial approach: Check each chunk exists before upload
- Optimization: Send all chunk hashes upfront, server responds with "needed" list
- Result: Significant bandwidth savings for duplicate content

### Iteration 3: Versioning
- Initially stored full copies of each version
- Changed to: Store chunk references per version
- Key insight: Versions can share chunks (deduplication applies to versions too)

## Questions and Discussions

**Q: How to handle sync conflicts?**
- Current approach: Last-write-wins (simple but lossy)
- Dropbox approach: Create conflict copies
- Future consideration: Three-way merge for text files

**Q: How to efficiently detect local changes?**
- Option 1: File system watcher (inotify/FSEvents)
- Option 2: Periodic full scan with hash comparison
- Best approach: Watcher for immediate detection, periodic scan as fallback

## Resources and References

- [Dropbox Tech Blog - Sync Engine](https://dropbox.tech/infrastructure)
- [Rabin Fingerprinting Paper](https://en.wikipedia.org/wiki/Rabin_fingerprint)
- [Delta Sync Algorithms](https://rsync.samba.org/tech_report/)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP backend
- [x] Implement frontend file browser
- [ ] Add desktop sync client
- [ ] Implement delta sync
- [ ] Add end-to-end encryption option
- [ ] Performance testing and optimization

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*
