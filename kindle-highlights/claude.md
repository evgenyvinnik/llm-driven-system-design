# Design Kindle Community Highlights - Development with Claude

## Project Context

Building a social reading platform to understand real-time sync, large-scale aggregation, and privacy-preserving social features.

**Key Learning Goals:**
- Build real-time sync across devices
- Design aggregation at scale (billions of highlights)
- Implement privacy-preserving community features
- Handle offline-first architecture

---

## Key Challenges to Explore

### 1. Real-time Sync

**Challenge**: Propagate highlights across devices in < 2 seconds

**Approaches:**
- WebSocket persistent connections
- Push notifications for offline devices
- Conflict resolution with timestamps
- Operation-based sync

### 2. Aggregation at Scale

**Problem**: Count highlights across millions of readers efficiently

**Solutions:**
- Redis counters for real-time
- Batch aggregation to PostgreSQL
- Passage normalization for grouping
- Caching for popular queries

### 3. Privacy

**Challenge**: Show community data without exposing individuals

**Solutions:**
- Anonymized aggregation
- Per-user privacy settings
- Opt-out from community
- Friends-only sharing

---

## Development Phases

### Phase 1: Core Highlights
- [ ] Highlight CRUD operations
- [ ] Local storage (SQLite)
- [ ] Basic sync protocol
- [ ] Personal library view

### Phase 2: Sync
- [ ] WebSocket server
- [ ] Conflict resolution
- [ ] Offline queue
- [ ] Multi-device testing

### Phase 3: Community
- [ ] Popular highlights aggregation
- [ ] Privacy settings
- [ ] Social features
- [ ] Export functionality

### Phase 4: Scale
- [ ] Redis caching
- [ ] Batch aggregation jobs
- [ ] Elasticsearch for search
- [ ] Performance optimization

---

## Resources

- [Amazon Kindle Popular Highlights](https://www.amazon.com/gp/help/customer/display.html?nodeId=201630920)
- [WebSocket Protocol](https://tools.ietf.org/html/rfc6455)
- [Conflict-free Replicated Data Types](https://crdt.tech/)
