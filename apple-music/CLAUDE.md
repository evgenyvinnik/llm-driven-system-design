# Design Apple Music - Development with Claude

## Project Context

Building a music streaming service to understand audio delivery, library management, and personalized recommendations.

**Key Learning Goals:**
- Build audio streaming infrastructure
- Design hybrid recommendation systems
- Implement library matching and sync
- Handle DRM and offline playback

---

## Key Challenges to Explore

### 1. Audio Quality

**Challenge**: Deliver lossless audio efficiently

**Approaches:**
- Adaptive bitrate selection
- Pre-buffering next track
- Gapless playback
- Network-aware quality

### 2. Library Matching

**Problem**: Match user uploads to catalog

**Solutions:**
- Audio fingerprinting (Chromaprint)
- Metadata matching
- Confidence scoring
- Manual override

### 3. Cross-Device Sync

**Challenge**: Keep library consistent across devices

**Solutions:**
- Sync token delta updates
- Conflict resolution
- Offline queue
- Background sync

---

## Development Phases

### Phase 1: Catalog - COMPLETED
- [x] Track/album/artist data
- [x] Search (PostgreSQL LIKE, Elasticsearch planned)
- [x] Metadata ingestion (seed data)
- [x] Artwork serving (MinIO placeholder)

### Phase 2: Streaming - IN PROGRESS
- [x] Audio file serving (MinIO URLs)
- [x] Adaptive quality (subscription tier based)
- [ ] DRM integration (placeholder only)
- [x] Gapless playback (queue prefetching)

### Phase 3: Library - COMPLETED
- [x] Library management
- [ ] Upload matching (schema ready, implementation pending)
- [x] Cross-device sync (sync tokens)
- [x] Smart playlists (schema ready)

### Phase 4: Discovery - COMPLETED
- [x] Listening history
- [x] Recommendations (For You sections)
- [x] Personalized radio
- [ ] Social features (follow friends, share)

---

## Implementation Notes

### What Was Built

1. **Backend (Express.js)**
   - Full REST API with authentication
   - Catalog browsing and search
   - Library management with sync tokens
   - Playlist CRUD operations
   - Radio stations (curated and personal)
   - Recommendation engine (genre-based, play history)
   - Admin dashboard API

2. **Frontend (React + Vite)**
   - Apple Music-inspired dark UI
   - Full audio player with queue
   - Browse, search, library views
   - Album, artist, playlist pages
   - Radio station player
   - Admin dashboard

3. **Infrastructure**
   - PostgreSQL for persistent data
   - Redis for session caching
   - MinIO for audio/artwork storage (S3-compatible)

### Trade-offs Made

| Decision | Chosen Approach | Alternative | Rationale |
|----------|-----------------|-------------|-----------|
| Search | PostgreSQL LIKE | Elasticsearch | Simpler setup for demo |
| Auth | Session + Redis | JWT | Easier revocation |
| Audio files | MinIO URLs | CDN + HLS | Demo simplicity |
| Recommendations | SQL-based | ML embeddings | No ML infrastructure |

### What's Missing (Future Phases)

1. **Real Audio Files** - Currently uses placeholder URLs
2. **DRM/FairPlay** - No actual encryption
3. **Upload Matching** - Fingerprinting not implemented
4. **Social Features** - No friend activity
5. **Offline Downloads** - No PWA service worker
6. **Real-time Updates** - No WebSocket for live sync

---

## Resources

- [Spotify Engineering Blog](https://engineering.atspotify.com/)
- [Audio Fingerprinting](https://acoustid.org/chromaprint)
- [Music Recommendation Systems](https://towardsdatascience.com/music-recommendation-system-spotify-dcf7c9e5d99)
